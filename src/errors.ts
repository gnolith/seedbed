export const ExitCode = {
  success: 0,
  usage: 2,
  configuration: 3,
  persistence: 4,
  authorization: 5,
  operation: 6,
} as const;

export class SeedbedError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SeedbedError';
  }
}

