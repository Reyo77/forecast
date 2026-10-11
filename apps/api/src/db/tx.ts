import type { Prisma } from '@prisma/client';
import type { prisma } from './client';

/** Either the base client or an interactive-transaction client. */
export type Tx = Prisma.TransactionClient | typeof prisma;
