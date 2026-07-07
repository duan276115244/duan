import type { UnifiedToolDef } from '../../core/unified-tool-def.js';
import { codeTools } from './code-tools.js';
import { fileTools } from './file-tools.js';
import { webTools } from './web-tools.js';
import { browserTools } from './browser-tools.js';
import { desktopTools } from './desktop-tools.js';
import { shellTools } from './shell-tools.js';
import { selfTools } from './self-tools.js';
import { memoryTools } from './memory-tools.js';
import { patchTools } from './patch-tools.js';
import { gitTools } from './git-tools.js';
import { thinkTools } from './think-tools.js';
import { agentTools } from './agent-tools.js';
import { planTools } from './plan-tools.js';
import { projectTools } from './project-tools.js';
import { sessionTools } from './session-tools.js';
import { skillTools } from './skill-tools.js';
import { fixTools } from './fix-tools.js';
import { dynamicTools, setBuiltInToolsProvider } from './dynamic-tools.js';
import { backgroundTools } from './background-tools.js';
import { marketplaceTools } from './marketplace-tools.js';
import { contextTools } from './context-tools.js';
import { teamTools } from './team-tools.js';
import { integrationTools } from './integration-tools.js';
import { libtvTools } from './libtv-tools.js';
import { videoTools } from './video-tools.js';
import { advancedTools } from './advanced-tools.js';
import { documentTools } from './document-tools.js';
import { mediaTools } from './media-tools.js';
import { pptTools } from './ppt-tools.js';
import { crossAppTools } from './cross-app-tools.js';
import { officeTools } from './office-tools.js';
import { officeToolsExtended } from './office-tools-extended.js';
import { officeToolsPro } from './office-tools-pro.js';
import { officeToolsUltimate } from './office-tools-ultimate.js';
import { toolContext } from './tool-context.js';

export const allBuiltInTools: UnifiedToolDef[] = [
  ...codeTools,
  ...fileTools,
  ...webTools,
  ...browserTools,
  ...desktopTools,
  ...shellTools,
  ...selfTools,
  ...memoryTools,
  ...patchTools,
  ...gitTools,
  ...thinkTools,
  ...agentTools,
  ...planTools,
  ...projectTools,
  ...sessionTools,
  ...skillTools,
  ...fixTools,
  ...dynamicTools,
  ...backgroundTools,
  ...marketplaceTools,
  ...contextTools,
  ...teamTools,
  ...integrationTools,
  ...libtvTools,
  ...videoTools,
  ...advancedTools,
  ...documentTools,
  ...mediaTools,
  ...pptTools,
  ...crossAppTools,
  ...officeTools,
  ...officeToolsExtended,
  ...officeToolsPro,
  ...officeToolsUltimate,
];

setBuiltInToolsProvider(() => allBuiltInTools);

export { toolContext };
