import type { ExtensionRegistry } from '../contracts/extension.js';
import { FacetRegistry } from '../contracts/facets.js';
import { ContributorRegistry } from '../contracts/verifier-contributor.js';
import { createDomainEvaluator } from '../verification/domain-evaluator.js';

/** Live composition views: retained verifier instances must not retain revoked registrations. */
export function extensionVerification(extensions: ExtensionRegistry) {
  const currentFacets = () => {
    const registry = new FacetRegistry();
    for (const provider of extensions.listFacetProviders()) registry.register(provider);
    return registry;
  };
  const currentContributors = () => {
    const registry = new ContributorRegistry();
    for (const contributor of extensions.listVerifierContributors()) registry.register(contributor);
    return registry;
  };
  // Keep the existing initialization validation; invalid extensions still fail Root assembly.
  currentFacets(); currentContributors();
  class LiveFacets extends FacetRegistry {
    override get(id: string) { return currentFacets().get(id); }
    override list() { return currentFacets().list(); }
    override forEnvironment(environment: 'browser' | 'windows') {
      return currentFacets().forEnvironment(environment);
    }
  }
  class LiveContributors extends ContributorRegistry {
    override get(id: string) { return currentContributors().get(id); }
    override list() { return currentContributors().list(); }
  }
  const facets = new LiveFacets(), contributors = new LiveContributors();
  return {
    facets, contributors, domainEvaluator: createDomainEvaluator(contributors, facets),
    get facetProviders() {
      return facets.list().map(provider => {
        const registration = extensions.facetRegistrationToken(provider);
        const active = () => registration !== undefined &&
          extensions.facetRegistrationToken(provider) === registration;
        return { id: provider.id, schemaVersion: provider.schemaVersion, providerVersion: provider.providerVersion,
          environment: provider.environment, source: provider.source,
          validate: (data: unknown) => active() ? provider.validate(data)
            : { ok: false as const, reason: 'facet-provider-unregistered' },
          async collect(ctx: Parameters<typeof provider.collect>[0]) {
            if (!active()) return undefined;
            const payload = await provider.collect(ctx);
            // Never accept a result from a revoked cycle, even when the same object is re-registered.
            return active() ? payload : undefined;
          },
        };
      });
    },
  };
}
