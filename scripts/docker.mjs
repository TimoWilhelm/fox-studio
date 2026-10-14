import { spawnSync } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import { streamlineImage } from '../src/shared/streamline-image.ts';
try { loadEnvFile('.env'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const name = 'fox-studio-local';
function docker(args, checked = true) {
  const result = spawnSync('docker', args, { stdio: 'inherit' });
  if (checked && result.status !== 0) throw new Error(`Docker ${args[0]} failed. Start Docker Desktop and try again.`);
}
if (process.argv[2] === 'stop') docker(['stop', name], false);
else {
  const image = streamlineImage(process.env.STREAMLINE_CONTAINER_IMAGE);
  docker(['info', '--format', '{{.ServerVersion}}']);
  if (spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' }).status !== 0) docker(['pull', '--platform', 'linux/amd64', image]);
  const existing = spawnSync('docker', ['inspect', '--format', '{{.Config.Image}}', name], { encoding: 'utf8' });
  if (existing.status === 0 && existing.stdout.trim() !== image) { docker(['stop', name]); docker(['rm', name]); }
  if (existing.status === 0 && existing.stdout.trim() === image) docker(['start', name]);
  else {
    docker(['run', '-d', '--platform', 'linux/amd64', '--name', name, '-p', '127.0.0.1:8788:8080', '-e', 'MAX_SESSION_DURATION_SECONDS=1800', '-e', 'ALLOWED_ORIGINS=http://127.0.0.1:5173,http://localhost:5173', image]);
  }
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try { ready = (await fetch('http://127.0.0.1:8788/health')).ok; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!ready) throw new Error('Streamline is not healthy. Inspect: docker logs fox-studio-local');
  console.log('Streamline Docker engine ready at http://127.0.0.1:8788. Run cf dev.');
}
