import { createAuthClient } from 'better-auth/react';

// Le MEME chemin que celui monte cote backend (`LAWYER_AUTH_MOUNT_PATH`). Il
// est ecrit ici en dur plutot que devine : la bibliotheque prefixe par
// `/api/auth` par defaut, ce que notre backend ne sert pas.
export const LAWYER_AUTH_BASE_PATH = '/api/v1/auth';

export const lawyer_auth_client = createAuthClient({ basePath: LAWYER_AUTH_BASE_PATH });
