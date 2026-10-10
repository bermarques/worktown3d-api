// Request bodies of the building routes. Size caps and trimming (title length, at most 10 assignees…) stay in the
// handlers, which accept long input and cut it down rather than reject it.
//
// class-validator runs a property's checks from the bottom up and reports the first failure, so the type check
// sits right above each property and the finer checks above it.
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, Matches, ValidateIf, ValidateNested } from 'class-validator';
import { LOGIN_RE, REPO_RE } from '../common/match.pipe.js';
import type { MergeMethod } from '../github/types.js';

const REPO = { message: 'Invalid repository name' };
const ASSIGNEES = { each: true, message: 'Invalid assignee' };
const TITLE = { message: 'An issue needs a title' };

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
  @Matches(REPO_RE, { each: true, ...REPO })
  @ArrayMaxSize(500, { message: 'floors must be an array' })
  @IsArray({ message: 'floors must be an array' })
  floors?: string[];

  @ValidateIf((o) => o.links !== undefined)
  @ValidateNested({ each: true, ...REPO })
  @Type(() => RepoLinkDto)
  @ArrayMaxSize(200, { message: 'links must be an array of at most 200' })
  @IsArray({ message: 'links must be an array of at most 200' })
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
  @Matches(/\S/, TITLE)
  @IsString(TITLE)
  title!: string;

  @IsOptional()
  @IsString({ message: 'The issue body must be text' })
  body?: string;

  @IsOptional()
  @Matches(LOGIN_RE, ASSIGNEES)
  @IsArray({ message: 'assignees must be a list' })
  assignees?: string[];

  @IsOptional()
  @IsString({ each: true, message: 'Labels must be text' })
  @IsArray({ message: 'labels must be a list' })
  labels?: string[];
}

export class UpdateIssueDto {
  @IsOptional()
  @Matches(LOGIN_RE, ASSIGNEES)
  @IsArray({ message: 'assignees must be a list' })
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
