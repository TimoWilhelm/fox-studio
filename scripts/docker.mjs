import { spawnSync } from 'node:child_process';
const name = 'fox-studio-local';
function docker(args, checked = true) {
  const result = spawnSync('docker', args, { stdio: 'inherit' });
  if (checked && result.status !== 0) throw new Error(`Docker ${args[0]} failed. Start Docker Desktop and try again.`);
}
if (process.argv[2] === 'stop') docker(['stop', name], false);
else {
  docker(['info', '--format', '{{.ServerVersion}}']);
  const exists = spawnSync('docker', ['inspect', name], { stdio: 'ignore' }).status === 0;
  if (exists) docker(['start', name]);
  else {
    docker(['build', '-t', 'fox-studio-streamline:0.1.0', './vendor/streamline/container']);
    docker(['run', '-d', '--name', name, '-p', '127.0.0.1:8788:8080', '-e', 'MAX_SESSION_DURATION_SECONDS=1800', '-e', 'ALLOWED_ORIGINS=http://127.0.0.1:5173,http://localhost:5173', 'fox-studio-streamline:0.1.0']);
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
