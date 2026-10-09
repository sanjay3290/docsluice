declare module 'node:process' {
  const process: {
    env: Record<string, string | undefined>;
    memoryUsage(): { heapUsed: number };
    stdout: { write(value: string): boolean };
  };
  export default process;
}
