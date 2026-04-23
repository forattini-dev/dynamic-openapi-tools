import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'parser/index': 'src/parser/index.ts',
    'auth/index': 'src/auth/index.ts',
    'bundle/index': 'src/bundle/index.ts',
    'utils/index': 'src/utils/index.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
})
