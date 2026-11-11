#!/usr/bin/env node
// Checks deploy/docker-compose.prod.yml and deploy/Caddyfile against the rules of docs/done/0.3.md (task 8.7):
// only Caddy publishes ports (never the API on 4000), the API trusts exactly the proxy in front of it
// (TRUST_PROXY), the web app trusts the hosting proxy (WEB_TRUSTED_PROXY_HOPS >= 1), production mode, Secure cookies,
// no development passwords and no floating image tags. No dependencies: `node scripts/check-deploy-config.mjs`.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Splits the text under "services:" into { name: block text } by two-space indentation. */
function serviceBlocks(compose) {
  const blocks = {};
  let inServices = false;
  let current = null;
  for (const line of compose.split('\n')) {
    if (/^\S/.test(line)) { inServices = /^services:\s*$/.test(line); current = null; continue; }
    if (!inServices) continue;
    const m = /^ {2}([\w-]+):\s*$/.exec(line);
    if (m) { current = m[1]; blocks[current] = ''; continue; }
    if (current) blocks[current] += `${line}\n`;
  }
  return blocks;
}

const value = (block, key) => {
  const m = new RegExp(`^\\s+${key}:\\s*"?([^"\\n#]*)"?\\s*(#.*)?$`, 'm').exec(block);
  return m ? m[1].trim() : null;
};

/** Returns a list of problems (empty when the configuration is acceptable). */
export function checkDeployConfig(compose, caddyfile) {
  const errors = [];
  const s = serviceBlocks(compose);
  for (const name of ['db', 'api', 'web', 'caddy']) if (!s[name]) errors.push(`service "${name}" is missing`);
  if (errors.length > 0) return errors;

  for (const [name, block] of Object.entries(s)) {
    if (name !== 'caddy' && /^\s+ports:/m.test(block)) errors.push(`service "${name}" publishes ports; only caddy may`);
    const image = value(block, 'image');
    if (image && (!image.includes(':') || image.endsWith(':latest'))) errors.push(`service "${name}" image "${image}" is not pinned to a tag`);
  }
  if (!/80:80/.test(s.caddy) || !/443:443/.test(s.caddy)) errors.push('caddy must publish 80 and 443');
  if (/4000/.test(s.caddy)) errors.push('caddy must not reach the API directly');

  if (value(s.api, 'APP_ENV') !== 'production') errors.push('api APP_ENV must be production');
  const trust = value(s.api, 'TRUST_PROXY');
  if (!trust || trust === 'false' || trust === 'true') errors.push('api TRUST_PROXY must name the web container\'s network (not unset, false or true)');
  if (value(s.api, 'COOKIE_SECURE') !== 'true') errors.push('api COOKIE_SECURE must be "true"');
  for (const key of ['EMAIL_HASH_KEY', 'FILE_SIGNING_KEY', 'APP_ENCRYPTION_KEY', 'AUTH_HMAC_KEY', 'WEB_ORIGIN', 'MT_APP_PASSWORD', 'MT_OWNER_PASSWORD']) {
    if (!new RegExp(`\\$\\{${key}:\\?`).test(s.api)) errors.push(`api ${key} must be required (\${${key}:?...})`);
  }
  const hops = Number(value(s.web, 'WEB_TRUSTED_PROXY_HOPS'));
  if (!Number.isInteger(hops) || hops < 1 || hops > 5) errors.push('web WEB_TRUSTED_PROXY_HOPS must be an integer from 1 to 5 (the hosting proxy count)');
  if (!/reverse_proxy\s+web:3000/.test(caddyfile)) errors.push('Caddyfile must reverse_proxy to web:3000');
  if (/reverse_proxy\s+api/.test(caddyfile)) errors.push('Caddyfile must not proxy to the API');
  if (/_dev\b|postgres_dev/.test(compose)) errors.push('development passwords appear in the production compose file');
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const errors = checkDeployConfig(
    readFileSync(join(root, 'deploy/docker-compose.prod.yml'), 'utf8'),
    readFileSync(join(root, 'deploy/Caddyfile'), 'utf8'),
  );
  if (errors.length > 0) {
    console.error(`check-deploy-config: ${errors.length} problem(s)\n- ${errors.join('\n- ')}`);
    process.exit(1);
  }
  console.log('check-deploy-config: ok');
}
