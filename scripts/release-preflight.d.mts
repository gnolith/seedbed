export function requestJson(url: string, options?: Record<string, any>): Promise<{ status: number; body: any }>;
export function classifyNpmVersion(status: number, body: any, expected: Record<string, string>): any;
export function classifyGhcrVersions(status: number, body: any, expectedVersion: string): any;
export function classifyGitHubRelease(status: number, body: any, expected: Record<string, string>): any;
export function classifyGitHubAttestations(status: number, body: any, expected: Record<string, string>): any;
export function validateTagEvidence(evidence: Record<string, any>): { version: string; commit: string };
export function createReleaseEvidence(input: Record<string, string>): Record<string, any>;
