// Request bodies of the building routes. Size caps and trimming (title length, at most 10 assignees…) stay in the
// handlers, which accept long input and cut it down rather than reject it.
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, Matches, ValidateIf, ValidateNested } from 'class-validator';
import { LOGIN_RE, REPO_RE } from '../common/match.pipe.js';
import type { MergeMethod } from '../github/types.js';

const REPO = { message: 'Invalid repository name' };
const ASSIGNEES = { each: true, message: 'Invalid assignee' };

export class RepoLinkDto {
  @Matches(REPO_RE, REPO)
  from!: string;

  @Matches(REPO_RE, REPO)
  to!: string;

  /** What the link means ("depends on", "calls the API of"…). */
  @IsOptional()
  @IsString({ message: 'A link kind must be text' })
  kind?: string;
}

export class SettingsDto {
  /** Repos with a floor, bottom to top. */
  @ValidateIf((o) => o.floors !== undefined)
  @IsArray({ message: 'floors must be an array' })
  @ArrayMaxSize(500, { message: 'floors must be an array' })
  @Matches(REPO_RE, { each: true, ...REPO })
  floors?: string[];

  @ValidateIf((o) => o.links !== undefined)
  @IsArray({ message: 'links must be an array of at most 200' })
  @ArrayMaxSize(200, { message: 'links must be an array of at most 200' })
  @ValidateNested({ each: true, ...REPO })
  @Type(() => RepoLinkDto)
  links?: RepoLinkDto[];
}

export class CreateRepoDto {
  @Matches(REPO_RE, REPO)
  name!: string;

  @IsOptional()
  @IsString({ message: 'description must be text' })
  description?: string;

  /** Default: private. */
  @IsOptional()
  @IsBoolean({ message: 'isPrivate must be true or false' })
  isPrivate?: boolean;

  /** Default: start with a README. */
  @IsOptional()
  @IsBoolean({ message: 'autoInit must be true or false' })
  autoInit?: boolean;
}

export class CreateIssueDto {
  @IsString({ message: 'An issue needs a title' })
  @Matches(/\S/, { message: 'An issue needs a title' })
  title!: string;

  @IsOptional()
  @IsString({ message: 'The issue body must be text' })
  body?: string;

  @IsOptional()
  @IsArray({ message: 'assignees must be a list' })
  @Matches(LOGIN_RE, ASSIGNEES)
  assignees?: string[];

  @IsOptional()
  @IsArray({ message: 'labels must be a list' })
  @IsString({ each: true, message: 'Labels must be text' })
  labels?: string[];
}

export class UpdateIssueDto {
  @IsOptional()
  @IsArray({ message: 'assignees must be a list' })
  @Matches(LOGIN_RE, ASSIGNEES)
  assignees?: string[];

  @IsOptional()
  @IsIn(['open', 'closed'], { message: 'Invalid state' })
  state?: 'open' | 'closed';
}

export class MergeDto {
  /** Default: squash. */
  @IsOptional()
  @IsIn(['merge', 'squash', 'rebase'], { message: 'Invalid merge method' })
  method?: MergeMethod;
}
