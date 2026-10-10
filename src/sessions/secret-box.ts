import crypto from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppConfig } from '../config/app-config.js';

const VERSION = 'v1';

/**
 * Authenticated encryption (AES-256-GCM) for secrets the server keeps outside its memory: GitHub tokens in the
 * sessions table, and the pending sign-in in the browser's state cookie. The key is derived from
 * GITHUB_CLIENT_SECRET, so rotating that secret also signs everyone out.
 */
@Injectable()
export class SecretBox {
  private readonly key: Buffer;

  constructor(config: AppConfig) {
    this.key = Buffer.from(crypto.hkdfSync('sha256', config.github!.clientSecret, 'worktown3d', 'secret-box v1', 32));
  }

  /** `context` binds the ciphertext to where it's kept (a session id, say), so it can't be replayed elsewhere. */
  seal(value: unknown, context: string) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context));
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
  }

  /** The sealed value, or null if it was tampered with, sealed for another context or with another key. */
  open<T>(sealed: string, context: string): T | null {
    const [version, iv, tag, data] = sealed.split('.');
    if (version !== VERSION || !iv || !tag || !data) return null;
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'), { authTagLength: 16 });
      decipher.setAAD(Buffer.from(context));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      const json = Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
      return JSON.parse(json) as T;
    } catch {
      return null;
    }
  }
}
