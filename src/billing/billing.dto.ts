import { Matches } from 'class-validator';
import { OWNER_RE } from '../common/match.pipe.js';

/** Back from Stripe Checkout: the session to confirm. */
export class ConfirmCheckoutDto {
  @Matches(/^cs_[A-Za-z0-9_]{10,200}$/, { message: 'Invalid checkout session' })
  sessionId!: string;
}

/** Connect an organization to the signed-in person's subscription. */
export class ConnectWorkspaceDto {
  @Matches(OWNER_RE, { message: 'Invalid organization' })
  org!: string;
}
