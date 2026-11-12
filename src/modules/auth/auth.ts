import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  Module,
  SetMetadata,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';

/**
 * AUTHENTICATION EXTENSION POINT (intentionally a no-op, see ARCHITECTURE.md).
 *
 * Intended design: providers authenticate with OAuth2 client credentials against an external
 * IdP (Keycloak). The guard validates the JWT (issuer, audience, signature via JWKS) and
 * stores the provider identity (`azp`/client id) on the request. ProviderIdentityPort then
 * checks that the authenticated client may act as the `providerId` in the payload.
 * Health endpoints are @Public. Queue messages are a trusted internal channel, but the
 * providerId inside them still goes through the same domain validation.
 */
export const IS_PUBLIC = 'auth:isPublic';
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);

@Injectable()
export class NoopAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;
    // Real implementation: verify the bearer token here and attach the identity.
    return true;
  }
}

/** Authorization of "who may act as which provider". */
export interface ProviderIdentityPort {
  assertMayActAs(providerId: string): void;
}
export const PROVIDER_IDENTITY = Symbol('ProviderIdentityPort');

/** No-op: every caller may act as any provider until the IdP is wired in. */
export class AllowAllProviderIdentity implements ProviderIdentityPort {
  assertMayActAs(): void {
    // intentionally empty
  }
}

@Module({
  providers: [
    { provide: APP_GUARD, useClass: NoopAuthGuard },
    { provide: PROVIDER_IDENTITY, useClass: AllowAllProviderIdentity },
  ],
  exports: [PROVIDER_IDENTITY],
})
export class AuthModule {}
