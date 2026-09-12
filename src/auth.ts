import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

import { config } from "./config.js";
import { getCookieSecret } from "./state.js";

const COOKIE_NAME = "lor_session";

function sign(payload: string): string {
  return createHmac("sha256", getCookieSecret()).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function issueToken(): string {
  const expiresAt = Date.now() + config.auth.sessionHours * 60 * 60 * 1000;
  const payload = String(expiresAt);
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token: string | undefined): boolean {
  if (!token) return false;
  const separator = token.lastIndexOf(".");
  if (separator < 0) return false;
  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (!safeEqual(signature, sign(payload))) return false;
  const expiresAt = Number(payload);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

export function checkPassword(candidate: unknown): boolean {
  if (config.auth.disabled) return true;
  if (typeof candidate !== "string" || !config.auth.password) return false;
  return safeEqual(candidate, config.auth.password);
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  const maxAge = config.auth.sessionHours * 60 * 60;
  // No Secure flag: this is typically reached over plain HTTP on an internal
  // network. Put it behind a TLS-terminating proxy if it is exposed.
  reply.header("Set-Cookie", `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`);
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.header("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

function readCookie(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

export function isAuthenticated(request: FastifyRequest): boolean {
  if (config.auth.disabled) return true;

  // A bearer token equal to the admin password lets scripts and health checks
  // call the API without carrying a cookie jar.
  const auth = request.headers.authorization;
  if (auth?.startsWith("Bearer ") && checkPassword(auth.slice(7))) return true;

  return verifyToken(readCookie(request, COOKIE_NAME));
}

/** Fastify preHandler guarding every route except login and static assets. */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (isAuthenticated(request)) return;
  await reply.code(401).send({ error: "Unauthorized" });
}

export function authConfigured(): boolean {
  return config.auth.disabled || Boolean(config.auth.password);
}
