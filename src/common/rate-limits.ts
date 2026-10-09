import { Injectable } from '@nestjs/common';
import { rateLimiter } from './security.js';

/** The server's rate limits, keyed by session (or client address before signing in). */
@Injectable()
export class RateLimits {
  readonly api = rateLimiter({ capacity: 120, perMinute: 240 });
  readonly write = rateLimiter({ capacity: 20, perMinute: 30 });
  readonly auth = rateLimiter({ capacity: 10, perMinute: 20 });
  readonly demo = rateLimiter({ capacity: 5, perMinute: 2 });
}
