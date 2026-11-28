/* SPDX-License-Identifier: Apache-2.0 */
/** Shared types for sf-pi doctor diagnostics and non-destructive repairs. */

export type DoctorSeverity = "ok" | "info" | "warn" | "error";

export interface DoctorIssue {
  id: string;
  severity: DoctorSeverity;
  title: string;
  detail: string;
  fix?: string;
}

export interface SkillLocation {
  name: string;
  file: string;
  root: string;
  rootLabel: string;
  rootKind: SkillRootKind;
  settingsValue?: string;
}

export type SkillRootKind =
  "omp" | "agents" | "claude" | "codex" | "cursor" | "project-omp" | "project-agents" | "settings";

export interface SkillCollision {
  name: string;
  locations: SkillLocation[];
  preferred: SkillLocation;
  duplicates: SkillLocation[];
}

export interface StaleSkillPath {
  raw: string;
  resolved: string;
}

export interface AvailableSkillRoot {
  label: string;
  settingsPath: string;
  absolutePath: string;
  skillCount: number;
}

export interface RuntimeDiagnostics {
  /** Native OMP host version (`getInstalledPiVersion()`). */
  ompVersion?: string;
  nodeVersion: string;
  nodePath: string;
}

export interface DoctorReport {
  ompVersion?: string;
  nodeVersion: string;
  runtime: RuntimeDiagnostics;
  welcomeMode?: string;
  safeStartRequested: boolean;
  welcomeDisabled: boolean;
  issues: DoctorIssue[];
  skillCollisions: SkillCollision[];
  staleSkillPaths: StaleSkillPath[];
  availableSkillRoots: AvailableSkillRoot[];
}

export interface StartupDoctorNudge {
  issueCount: number;
  collisionCount: number;
  staleSkillPathCount: number;
  safeStartRequested: boolean;
  message: string;
  command: string;
}

export interface DoctorFixOptions {
  fixStartup?: boolean;
  fixSkills?: boolean;
  fixStaleSkillPaths?: boolean;
  fixSkillLinks?: boolean;
  home?: string;
  cwd?: string;
  now?: Date;
}

export interface QuarantinedSkill {
  name: string;
  from: string;
  to: string;
}

export interface DoctorFixResult {
  changed: boolean;
  messages: string[];
  quarantinedSkills: QuarantinedSkill[];
  quarantineDir?: string;
}
