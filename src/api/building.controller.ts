import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { HttpError, statusOf } from '../common/http-error.js';
import { LOGIN_RE, Match, need, PositiveInt, REPO_RE } from '../common/match.pipe.js';
import { sendText } from '../common/respond.js';
import { ViewCache } from '../common/view-cache.js';
import { AppConfig } from '../config/app-config.js';
import { fetchAvatar } from '../github/github-provider.js';
import type { IssuePatch, MergeMethod } from '../github/types.js';
import type { RepoLink } from '../settings/settings.service.js';
import { BuildingService } from './building.service.js';
import { Ctx, type ApiContext } from './context.js';

// Request bodies are parsed JSON objects, checked field by field below.
type Json = Record<string, any>;

const list = (v: unknown, max = 20): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);

/** A building: its floors, issues and pull requests, and the layout settings (both modes). */
@Controller('api')
export class BuildingController {
  private readonly avatars = new Map<string, { at: number; img: { buffer: Buffer; type: string } | null }>();

  constructor(
    private readonly config: AppConfig,
    private readonly building: BuildingService,
    private readonly cache: ViewCache,
  ) {}

  @Get('world')
  async world(@Ctx() context: ApiContext, @Query('fresh') fresh?: string) {
    const { ctx, access } = await this.building.requireBuilding(context);
    const world = await this.building.getWorld(ctx, fresh === '1');
    return {
      mode: ctx.provider.mode,
      viewer: ctx.viewer,
      access,
      owner: world.owner,
      repos: world.repos,
      memberCount: world.members ? world.members.length : null,
      members: world.members ? world.members.map((m) => ({ login: m.login, name: m.name })) : null,
      floors: await this.building.floorsFor(ctx, world),
      links: (await ctx.settings.get()).links,
    };
  }

  @Get('floor/:repo')
  async floor(@Ctx() context: ApiContext, @Param('repo', new Match(REPO_RE, 'repository name')) repo: string, @Query('fresh') fresh?: string) {
    const { ctx } = await this.building.requireBuilding(context);
    const world = await this.building.getWorld(ctx);
    return this.cache.cached(`${ctx.ns}:${ctx.owner}:floor:${repo}`, 30_000, () => ctx.provider.getFloor(world, repo), fresh === '1');
  }

  @Get('labels/:repo')
  async labels(@Ctx() context: ApiContext, @Param('repo', new Match(REPO_RE, 'repository name')) repo: string) {
    const { ctx } = await this.building.requireBuilding(context);
    return this.cache.cached(`${ctx.ns}:${ctx.owner}:labels:${repo}`, 300_000, () => ctx.provider.listLabels(ctx.owner, repo));
  }

  // Building layout (floors + links) is Worktown3D's own data, not GitHub's, so we enforce who may change it.
  @Put('settings')
  async settings(@Ctx() context: ApiContext, @Body() body: Json) {
    const { ctx, access } = await this.building.requireBuilding(context);
    if (!access.canManage) throw new HttpError(403, 'Only organization owners can change the building layout');
    const world = await this.building.getWorld(ctx);
    const patch: { floors?: string[]; links?: RepoLink[] } = {};
    if (body.floors !== undefined) {
      if (!Array.isArray(body.floors) || body.floors.length > 500) throw new HttpError(400, 'floors must be an array');
      patch.floors = [...new Set(body.floors.map((f) => need(f, REPO_RE, 'repository name')))];
    }
    if (body.links !== undefined) {
      if (!Array.isArray(body.links) || body.links.length > 200) throw new HttpError(400, 'links must be an array of at most 200');
      patch.links = body.links.map((l) => ({
        from: need(l && l.from, REPO_RE, 'repository name'),
        to: need(l && l.to, REPO_RE, 'repository name'),
        kind: String((l && l.kind) || 'depends on').slice(0, 40),
      }));
    }
    const settings = await ctx.settings.update(patch);
    this.cache.invalidate(`${ctx.ns}:${ctx.owner}:world`);
    return { floors: await this.building.floorsFor(ctx, world), links: settings.links };
  }

  @Post('repos')
  @HttpCode(200)
  async createRepo(@Ctx() context: ApiContext, @Body() body: Json) {
    const { ctx, access } = await this.building.requireBuilding(context);
    if (!access.canCreateRepo) throw new HttpError(403, `You don't have permission to create repositories in ${ctx.owner}`);
    const world = await this.building.getWorld(ctx);
    const name = need(body.name, REPO_RE, 'repository name');
    const created = await ctx.provider.createRepo(world, {
      name,
      description: String(body.description || '').slice(0, 350),
      isPrivate: body.isPrivate !== false,
      autoInit: body.autoInit !== false,
    });
    // Give the new project a floor right away (if this person may change the layout).
    if (access.canManage) {
      const floors = await this.building.floorsFor(ctx, world);
      await ctx.settings.update({ floors: [...floors.filter((f) => f !== created.name), created.name] });
    }
    this.cache.invalidate(`${ctx.ns}:${ctx.owner}:world`);
    return created;
  }

  @Post('issues/:repo')
  @HttpCode(200)
  async createIssue(@Ctx() context: ApiContext, @Param('repo', new Match(REPO_RE, 'repository name')) repo: string, @Body() body: Json) {
    const { ctx } = await this.building.requireBuilding(context);
    const title = String(body.title || '').trim();
    if (!title) throw new HttpError(400, 'An issue needs a title');
    const assignees = list(body.assignees, 10).map((a) => need(a, LOGIN_RE, 'assignee'));
    const labels = list(body.labels, 20).map((l) => String(l).slice(0, 50));
    const created = await ctx.provider.createIssue(ctx.owner, repo, { title: title.slice(0, 256), body: String(body.body || '').slice(0, 60_000), assignees, labels });
    this.invalidateRepo(ctx, repo);
    return created;
  }

  @Patch('issues/:repo/:number')
  async updateIssue(
    @Ctx() context: ApiContext,
    @Param('repo', new Match(REPO_RE, 'repository name')) repo: string,
    @Param('number', new PositiveInt('issue number')) number: number,
    @Body() body: Json,
  ) {
    const { ctx } = await this.building.requireBuilding(context);
    const patch: IssuePatch = {};
    if (body.assignees) patch.assignees = list(body.assignees, 10).map((a) => need(a, LOGIN_RE, 'assignee'));
    if (body.state) {
      if (!['open', 'closed'].includes(body.state)) throw new HttpError(400, 'Invalid state');
      patch.state = body.state;
    }
    const result = await ctx.provider.updateIssue(ctx.owner, repo, number, patch);
    this.invalidateRepo(ctx, repo);
    return result;
  }

  @Post('prs/:repo/:number/merge')
  @HttpCode(200)
  async mergePR(
    @Ctx() context: ApiContext,
    @Param('repo', new Match(REPO_RE, 'repository name')) repo: string,
    @Param('number', new PositiveInt('pull request number')) number: number,
    @Body() body: Json,
  ) {
    const { ctx } = await this.building.requireBuilding(context);
    const method: MergeMethod = ['merge', 'squash', 'rebase'].includes(body.method) ? body.method : 'squash';
    const result = await ctx.provider.mergePR(ctx.owner, repo, number, method);
    this.invalidateRepo(ctx, repo);
    return result;
  }

  /** Same-origin avatar proxy, so canvases stay untainted. */
  @Get('avatar/:login')
  async avatar(@Ctx() ctx: ApiContext, @Param('login') login: string, @Res() res: Response) {
    try {
      need(login, LOGIN_RE, 'login');
      if (this.config.hosted) this.building.requireSession(ctx);
    } catch (e) {
      return sendText(res, statusOf(e), 'no avatar');
    }
    if (ctx.provider && ctx.provider.mode === 'demo') return sendText(res, 404, 'no avatar');
    let entry = this.avatars.get(login);
    if (!entry || Date.now() - entry.at > 6 * 3600_000) {
      const img = await fetchAvatar(login).catch(() => null);
      entry = { at: Date.now(), img };
      if (this.avatars.size > 2000) this.avatars.clear();
      this.avatars.set(login, entry);
    }
    if (!entry.img) return sendText(res, 404, 'no avatar');
    res.status(200).set({ 'Content-Type': entry.img.type, 'Cache-Control': 'private, max-age=3600' }).end(entry.img.buffer);
  }

  private invalidateRepo(ctx: { ns: string; owner: string }, repo: string) {
    this.cache.invalidate(`${ctx.ns}:${ctx.owner}:floor:${repo}`);
    this.cache.invalidate(`${ctx.ns}:${ctx.owner}:world`);
  }
}
