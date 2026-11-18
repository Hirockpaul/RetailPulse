import { startTracing } from './tracing';

const sdk = startTracing();

if (sdk) {
  process.once('beforeExit', () => {
    void sdk.shutdown();
  });
}
