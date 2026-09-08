// Ici et pas dans un module metier : `config/` comme `auth/` ont besoin de ce
// type, et le faire porter par l'un des deux forcerait l'autre a en dependre.
// La couche configuration importait ce type depuis un fichier d'authentification.
export type NodeEnvironment = 'development' | 'test' | 'production';

export const VALID_NODE_ENVIRONMENTS: readonly NodeEnvironment[] = [
  'development',
  'test',
  'production',
];

export function is_valid_node_environment(value: string): value is NodeEnvironment {
  return (VALID_NODE_ENVIRONMENTS as readonly string[]).includes(value);
}
