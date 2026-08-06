import { CustomError } from 'ts-custom-error';

export class ColibriError extends CustomError {}

/**
 * Raised when the server refuses this client because it speaks a different wire protocol.
 *
 * This is terminal, not transient: there is no negotiation and no subset both sides can
 * speak, so reconnecting cannot succeed. `Colibri` stops Socket.IO from retrying when it
 * receives one, and the fix is always to align the `colibri-web` and `colibri-server`
 * versions.
 */
export class ProtocolMismatchError extends ColibriError {
    public constructor(
        message: string,
        public readonly serverVersion: string,
        public readonly clientVersion: string
    ) {
        super(message);
    }
}
