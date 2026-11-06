// 簡易パスワード認証（モックを外部公開するための最低限の保護）。
// 単一パスワード・署名付きCookie。本番の認証基盤の代替ではない。

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.js';

const COOKIE = 'sts_mock_auth';
const MAX_AGE_SEC = 12 * 3600;

function sign(payload: string) {
  return createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
}

export function issueToken(): string {
  const payload = `v1.${Math.floor(Date.now() / 1000)}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(tok: string | undefined): boolean {
  if (!tok) return false;
  const i = tok.lastIndexOf('.');
  if (i < 0) return false;
  const payload = tok.slice(0, i);
  const sig = tok.slice(i + 1);
  const expect = sign(payload);
  if (sig.length !== expect.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return false;
  const ts = Number(payload.split('.')[1]);
  return Number.isFinite(ts) && Date.now() / 1000 - ts < MAX_AGE_SEC;
}

function readCookie(req: Request, name: string): string | undefined {
  const h = req.headers.cookie ?? '';
  for (const part of h.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export function passwordMatches(input: string): boolean {
  if (!config.appPassword) return !config.production; // ローカル開発でパスワード未設定なら許可
  const a = Buffer.from(sign(`pw:${input}`));
  const b = Buffer.from(sign(`pw:${config.appPassword}`));
  return timingSafeEqual(a, b);
}

export function setAuthCookie(req: Request, res: Response) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `${COOKIE}=${issueToken()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${MAX_AGE_SEC}${secure ? '; Secure' : ''}`);
}

export function clearAuthCookie(res: Response) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

export function isAuthed(req: Request): boolean {
  if (!config.appPassword && !config.production) return true;
  return verifyToken(readCookie(req, COOKIE));
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: 'unauthorized' });
}

// ログイン試行の簡易レート制限（IP単位、10分で10回）
const attempts = new Map<string, number[]>();
export function loginRateLimited(ip: string): boolean {
  const now = Date.now();
  const arr = (attempts.get(ip) ?? []).filter((t) => now - t < 10 * 60_000);
  arr.push(now);
  attempts.set(ip, arr);
  return arr.length > 10;
}
