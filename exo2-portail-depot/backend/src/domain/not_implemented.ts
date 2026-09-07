export class NotImplementedError extends Error {
  constructor(functionName: string) {
    super(`${functionName} n'est pas encore implemente`);
    this.name = 'NotImplementedError';
  }
}
