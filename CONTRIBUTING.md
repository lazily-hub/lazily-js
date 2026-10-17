# Contributing to lazily-js

## Verify a change

```bash
make check   # npm run build && npm test
```

- `npm run build` runs `node --check` over every shipped module.
- `npm run test:formal` builds `lazily-formal` when the sibling checkout and
  `lake` are present.
- `npm test` runs the formal check and the Node test suite.
