export class WorkerEntrypoint<E> {
  constructor(
    protected ctx: ExecutionContext,
    protected env: E,
  ) {}
}
