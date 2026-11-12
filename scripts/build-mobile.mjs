// Builds the web app and copies it to app-build/, which is committed to git, so a phone (Termux) or a small server
// can run the app without installing Vite and Tailwind. Run it again after you change anything in client/.
import { cpSync, existsSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';

execSync('npm run build', { stdio: 'inherit' });
if (!existsSync('client/dist/index.html')) throw new Error('The build did not produce client/dist');
rmSync('app-build', { recursive: true, force: true });
cpSync('client/dist', 'app-build', { recursive: true });
console.log('Copied to app-build/. Commit it so the phone gets the new app.');
