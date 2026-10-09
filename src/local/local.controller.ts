import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { HttpError } from '../common/http-error.js';
import { need, OWNER_RE } from '../common/match.pipe.js';
import { getConfig, setConnection } from './local-config.js';
import { LocalGh } from './local-gh.service.js';

/** Status and organization choice in local mode (GitHub CLI or demo company). */
@Controller('api')
export class LocalController {
  constructor(private readonly local: LocalGh) {}

  @Get('status')
  status() {
    return this.local.status();
  }

  /** Re-detect the GitHub CLI after installing/signing in. */
  @Post('recheck')
  @HttpCode(200)
  async recheck() {
    await this.local.recheck();
    return this.local.status();
  }

  @Get('owners')
  owners() {
    return (this.local.ghProvider() ?? this.local.provider).listOwners();
  }

  @Post('connect')
  @HttpCode(200)
  connect(@Body() body: Record<string, unknown>) {
    if (body.demo) setConnection({ owner: getConfig().owner, demo: true });
    else {
      if (!this.local.gh.authed) throw new HttpError(409, 'GitHub CLI is not logged in. Run `gh auth login` first.');
      setConnection({ owner: need(body.owner, OWNER_RE, 'organization'), demo: false });
    }
    this.local.selectProvider();
    return this.local.status();
  }
}
