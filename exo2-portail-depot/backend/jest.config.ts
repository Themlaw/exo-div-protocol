import type { Config } from 'jest';
import { pathsToModuleNameMapper } from 'ts-jest';
import ts from 'typescript';

// Path aliases (e.g. the ones added by `nest g library`) live in tsconfig.json,
// so they are read from there instead of being duplicated here.
const { config: tsconfig } = ts.readConfigFile(
  './tsconfig.json',
  ts.sys.readFile,
);
const paths = tsconfig?.compilerOptions?.paths ?? {};

const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  roots: ['<rootDir>/test/unit'],
  testRegex: '.*\\.spec\\.ts$',
  // L'historique d'appels des mocks fuirait d'un test a l'autre sans cette remise a zero.
  clearMocks: true,
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  moduleNameMapper: pathsToModuleNameMapper(paths, { prefix: '<rootDir>/' }),
  collectCoverageFrom: [
    'src/**/*.(t|j)s',
    'libs/**/*.(t|j)s',
    'apps/**/*.(t|j)s',
  ],
  coverageDirectory: './coverage',
  testEnvironment: 'node',
  // Le defaut de 5 s suffit a tout SAUF aux tests d'argon2, qui sont lents par
  // construction : chaque hachage coute ~130 ms et occupe un des quatre fils du
  // threadpool libuv, partages par tous les processus jest. Sous charge, une
  // poignee de hachages depassait la limite et rendait un rouge qui ne
  // designait aucun defaut du code.
  testTimeout: 30_000,
};

export default config;
