export class Greeter {
  constructor(private readonly name: string) {}

  greet(message: string): string {
    return `${message}, ${this.name}`;
  }
}

export function sum(left: number, right: number): number {
  return left + right;
}
