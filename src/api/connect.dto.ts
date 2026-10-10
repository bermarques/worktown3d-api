import { IsBoolean, IsOptional, Matches, ValidateIf } from 'class-validator';
import { OWNER_RE } from '../common/match.pipe.js';

const ORG = { message: 'Invalid organization' };

/** Hosted mode: open this organization's (or the viewer's personal) building. */
export class ConnectDto {
  @Matches(OWNER_RE, ORG)
  owner!: string;
}

/** Local mode: open an organization's building through `gh`, or the demo company. */
export class LocalConnectDto {
  @IsOptional()
  @IsBoolean({ message: 'demo must be true or false' })
  demo?: boolean;

  @ValidateIf((o) => !o.demo)
  @Matches(OWNER_RE, ORG)
  owner?: string;
}
