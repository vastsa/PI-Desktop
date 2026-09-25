/** Read-only pi CLI npm package candidates. Discovery grants no permissions. */
export interface PiSkillPackageCandidate {
  id: string;
  name: string;
  path: string;
  skills: string[];
  hasExtensions: boolean;
  imported: boolean;
}
export interface PiSkillDiscovery {
  candidates: PiSkillPackageCandidate[];
  errors: string[];
}
