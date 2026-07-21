import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sourceDir = path.join(__dirname, '../vault/knowledge');
const destDir = path.join(__dirname, '../public/knowledge');

if (fs.existsSync(sourceDir)) {
  console.log('Copying trainings to public/trainings for Vercel deployment...');
  fs.cpSync(sourceDir, destDir, { recursive: true });
  console.log('Done.');
}
