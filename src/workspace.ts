import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.resolve(__dirname, '..', 'templates', 'workspace');

export interface WorkspaceFiles {
  soul: string;
  agents: string;
  identity: string;
  user: string;
  bootstrap: string;
}

export function initWorkspace(workspaceDir: string): WorkspaceFiles {
  if (!fs.existsSync(workspaceDir)) {
    fs.mkdirSync(workspaceDir, { recursive: true });
  }

  const files: WorkspaceFiles = {
    soul: path.join(workspaceDir, 'SOUL.md'),
    agents: path.join(workspaceDir, 'AGENTS.md'),
    identity: path.join(workspaceDir, 'IDENTITY.md'),
    user: path.join(workspaceDir, 'USER.md'),
    bootstrap: path.join(workspaceDir, 'BOOTSTRAP.md'),
  };

  const templates: Record<string, string> = {
    'SOUL.md': '',
    'AGENTS.md': '',
    'IDENTITY.md': '',
    'USER.md': '',
    'BOOTSTRAP.md': '',
  };

  if (fs.existsSync(TEMPLATES_DIR)) {
    for (const name of Object.keys(templates)) {
      const tmpl = path.join(TEMPLATES_DIR, name);
      if (fs.existsSync(tmpl)) {
        templates[name] = fs.readFileSync(tmpl, 'utf-8');
      }
    }
  }

  for (const [_file, content] of Object.entries(files)) {
    if (!fs.existsSync(content)) {
      const templateName = path.basename(content);
      const templateContent = templates[templateName];
      if (templateContent) {
        fs.writeFileSync(content, templateContent, 'utf-8');
      } else {
        fs.writeFileSync(content, `# ${templateName}\n\n*由段先生自动创建*\n`, 'utf-8');
      }
    }
  }

  return files;
}
