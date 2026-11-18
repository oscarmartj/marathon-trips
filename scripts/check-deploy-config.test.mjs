import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkDeployConfig } from './check-deploy-config.mjs';

const compose = readFileSync(new URL('../deploy/docker-compose.prod.yml', import.meta.url), 'utf8');
const caddy = readFileSync(new URL('../deploy/Caddyfile', import.meta.url), 'utf8');
const problems = (c, f = caddy) => checkDeployConfig(c, f).join('|');

test('the shipped production configuration passes', () => {
  assert.deepEqual(checkDeployConfig(compose, caddy), []);
});

test('publishing the API port fails', () => {
  const bad = compose.replace('    # No "ports": the API is never published.', '    ports: ["4000:4000"]');
  assert.match(problems(bad), /service "api" publishes ports/);
});

test('missing or disabled TRUST_PROXY fails', () => {
  assert.match(problems(compose.replace('TRUST_PROXY: uniquelocal', 'TRUST_PROXY: "false"')), /TRUST_PROXY/);
  assert.match(problems(compose.replace('      TRUST_PROXY: uniquelocal\n', '')), /TRUST_PROXY/);
});

test('missing WEB_TRUSTED_PROXY_HOPS or zero hops fails', () => {
  assert.match(problems(compose.replace('WEB_TRUSTED_PROXY_HOPS: "1"', 'WEB_TRUSTED_PROXY_HOPS: "0"')), /WEB_TRUSTED_PROXY_HOPS/);
  assert.match(problems(compose.replace(/ {6}WEB_TRUSTED_PROXY_HOPS: "1"\n/, '')), /WEB_TRUSTED_PROXY_HOPS/);
});

test('non-production mode, insecure cookies, dev passwords and floating tags fail', () => {
  assert.match(problems(compose.replace('APP_ENV: production', 'APP_ENV: staging')), /APP_ENV/);
  assert.match(problems(compose.replace('COOKIE_SECURE: "true"', 'COOKIE_SECURE: "false"')), /COOKIE_SECURE/);
  assert.match(problems(compose.replace('${MT_APP_PASSWORD:?}', 'mt_app_dev')), /MT_APP_PASSWORD|development passwords/);
  assert.match(problems(compose.replace('caddy:2', 'caddy:latest')), /not pinned/);
});

test('Caddy proxying to the API fails', () => {
  assert.match(problems(compose, 'x {\n reverse_proxy api:4000\n}'), /Caddyfile/);
});

test('task 8.6: the backup service must be opt-in, read uploads read-only, stay encrypted and never be published', () => {
  assert.match(problems(compose.replace(/ {4}profiles: \["tools"\]\n/, '')), /"tools" profile/);
  assert.match(problems(compose.replace('filedata:/data/files:ro', 'filedata:/data/files')), /read-only/);
  assert.match(problems(compose.replace(/(backup:[\s\S]*?)APP_ENV: production/, '$1APP_ENV: staging')), /backup" APP_ENV/);
  assert.match(problems(compose.replace('BACKUP_DIR: /backups', 'BACKUP_DIR: /backups\n      BACKUP_ALLOW_LOCAL_ONLY: "yes"')), /local-only/);
  assert.match(problems(compose.replace('      BACKUP_PASSPHRASE_FILE: /run/backup-passphrase\n', '')), /BACKUP_PASSPHRASE_FILE/);
  assert.match(problems(compose.replace('    entrypoint: ["bash", "/scripts/backup/backup.sh"]', '    entrypoint: ["bash", "/scripts/backup/backup.sh"]\n    ports: ["5000:5000"]')), /publishes ports/);
  assert.match(problems(compose.replace('backups:/backups:ro', 'backups:/backups')), /backups volume read-only/);
  assert.match(problems(compose.replace(/ {2}backup:\n[\s\S]*?\nvolumes:/, 'volumes:')), /"backup" is missing/);
});

test('task 1.fix-1: WEB_ORIGIN must reach the web build and the web container, and never be local or http', () => {
  assert.match(problems(compose.replace(/target: web, args: \{[^}]*\}/, 'target: web')), /build must pass WEB_ORIGIN/);
  assert.match(problems(compose.replace('      WEB_ORIGIN: ${WEB_ORIGIN:?set the public https:// address}\n      # The web', '      # The web')), /api WEB_ORIGIN/);
  const webEnv = '      API_BASE_URL: http://api:4000\n      WEB_ORIGIN: ${WEB_ORIGIN:?set the public https:// address}\n';
  assert.ok(compose.includes(webEnv));
  assert.match(problems(compose.replace(webEnv, '      API_BASE_URL: http://api:4000\n')), /web WEB_ORIGIN must be required at run time/);
  assert.match(problems(compose.replace(webEnv, '      API_BASE_URL: http://api:4000\n      WEB_ORIGIN: http://localhost:3000\n')), /localhost or http/);
  assert.match(problems(compose.replace(webEnv, '      API_BASE_URL: http://api:4000\n      WEB_ORIGIN: http://example.com.au\n')), /localhost or http/);
});

test('Caddyfile without a request body limit fails (task 8.5)', () => {
  assert.match(problems(compose, caddy.replace(/request_body\s*\{[^}]*\}/, '')), /request_body max_size/);
});
