/**
 * Bedrock protocol adapter.
 *
 * Extracted from the original model.ts — same behavior, new home.
 * Uses @anthropic-ai/bedrock-sdk with bearer token or AWS credential chain.
 * Aggressive retry on 429/529, auto-recreate client on 403.
 */
import AnthropicBedrock from '@anthropic-ai/bedrock-sdk';
import type { MessageStream } from '@anthropic-ai/sdk/lib/MessageStream';
import type { ApiProtocol, ProtocolAdapter, AdapterCallOptions, ModelResult } from './types.js';
import {
  MAX_RETRIES, isAuthError, isRetryableError, getRetryDelay, sleep,
  abortedResult, extractUsage,
} from './retry.js';
import { log } from '../../logging/index.js';

export class BedrockAdapter implements ProtocolAdapter {
  readonly protocol: ApiProtocol = 'bedrock';
  private client: AnthropicBedrock | null = null;
  private lastConfig: string | null = null;

  private createClient(config: {
    region?: string;
    bearerToken?: string;
    accessKey?: string;
    secretKey?: string;
    profile?: string;
  }): AnthropicBedrock {
    const effectiveRegion = config.region ?? process.env.AWS_REGION ?? 'us-west-2';

    // Bearer token auth (Identity Center / SSO)
    if (config.bearerToken) {
      return new AnthropicBedrock({
        awsRegion: effectiveRegion,
        skipAuth: true,
        authToken: config.bearerToken,
      } as unknown as ConstructorParameters<typeof AnthropicBedrock>[0]);
    }

    // Explicit access key + secret
    if (config.accessKey && config.secretKey) {
      return new AnthropicBedrock({
        awsRegion: effectiveRegion,
        awsAccessKey: config.accessKey,
        awsSecretKey: config.secretKey,
      });
    }

    // AWS profile — use providerChainResolver to specify profile
    if (config.profile) {
      return new AnthropicBedrock({
        awsRegion: effectiveRegion,
        providerChainResolver: () =>
          import('@aws-sdk/credential-providers').then(({ fromNodeProviderChain }) =>
            fromNodeProviderChain({ profile: config.profile }),
          ),
      } as unknown as ConstructorParameters<typeof AnthropicBedrock>[0]);
    }

    // Default: AWS credential chain (env vars → ~/.aws/credentials → instance metadata)
    return new AnthropicBedrock({ awsRegion: effectiveRegion });
  }

  private getClient(config: {
    region?: string;
    bearerToken?: string;
    accessKey?: string;
    secretKey?: string;
    profile?: string;
  }): AnthropicBedrock {
    const configKey = `${config.region}:${config.bearerToken?.slice(-6) ?? ''}:${config.accessKey?.slice(-4) ?? ''}:${config.profile ?? ''}`;
    if (this.client && this.lastConfig === configKey) return this.client;
    this.client = this.createClient(config);
    this.lastConfig = configKey;
    return this.client;
  }

  resetClient(): void {
    this.client = null;
    this.lastConfig = null;
  }

  async sendMessage(opts: AdapterCallOptions): Promise<ModelResult> {
    const { model, providerConfig } = opts;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const bedrock = this.getClient({
          region: providerConfig.region,
          bearerToken: providerConfig.bearer_token,
          accessKey: providerConfig.aws_access_key_id,
          secretKey: providerConfig.aws_secret_access_key,
          profile: providerConfig.aws_profile,
        });
      try {
        const params = {
          model,
          max_tokens: opts.maxTokens,
          system: opts.system,
          messages: opts.messages,
          tools: opts.tools,
          // Note: temperature must not be set when thinking is enabled (API defaults to 1.0)
          ...(opts.thinking && opts.thinking.type !== 'disabled' && { thinking: opts.thinking }),
        };
        const requestOpts = opts.signal ? { signal: opts.signal } : undefined;
        // Use beta endpoint when betas are specified (e.g., 1M context window).
        // BetaMessage and Message are structurally identical — safe to treat as same shape.
        const response: { content: any; stop_reason: any; usage?: any } = opts.betas?.length
          ? await (bedrock.beta.messages.create as any)(
              { ...params, betas: opts.betas },
              requestOpts,
            )
          : await bedrock.messages.create(params, requestOpts);

        return { content: response.content, stopReason: response.stop_reason, usage: extractUsage(response.usage) };
      } catch (err) {
        if (opts.signal?.aborted) return abortedResult();
        if (isAuthError(err) && attempt === 0) {
          log.agent.warn('403 auth error, recreating Bedrock client and retrying');
          this.resetClient();
          continue;
        }
        if (isRetryableError(err) && attempt < MAX_RETRIES) {
          const delay = getRetryDelay(attempt, err);
          log.agent.warn(`bedrock 429/529 on attempt ${attempt + 1}/${MAX_RETRIES + 1}, retrying in ${Math.round(delay)}ms`);
          await sleep(delay, opts.signal);
          if (opts.signal?.aborted) return abortedResult();
          continue;
        }
        throw err;
      }
    }
    throw new Error('Unreachable: retry loop exhausted');
  }

  async sendMessageStream(
    opts: AdapterCallOptions & { onTextDelta?: (delta: string) => void },
  ): Promise<ModelResult> {
    const { model, providerConfig } = opts;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let accumulatedText = '';

      try {
        const bedrock = this.getClient({
          region: providerConfig.region,
          bearerToken: providerConfig.bearer_token,
          accessKey: providerConfig.aws_access_key_id,
          secretKey: providerConfig.aws_secret_access_key,
          profile: providerConfig.aws_profile,
        });
        const streamParams = {
          model,
          max_tokens: opts.maxTokens,
          system: opts.system,
          messages: opts.messages,
          tools: opts.tools,
          // Note: temperature must not be set when thinking is enabled (API defaults to 1.0)
          ...(opts.thinking && opts.thinking.type !== 'disabled' && { thinking: opts.thinking }),
        };
        // Use beta endpoint when betas are specified (e.g., 1M context window).
        // BetaMessageStream and MessageStream are structurally compatible (same on/abort/finalMessage).
        const stream: MessageStream = opts.betas?.length
          ? (bedrock.beta.messages.stream as any)(
              { ...streamParams, betas: opts.betas },
            )
          : bedrock.messages.stream(streamParams);

        if (opts.signal) {
          if (opts.signal.aborted) {
            stream.abort();
          } else {
            opts.signal.addEventListener('abort', () => stream.abort(), { once: true });
          }
        }

        stream.on('text', (textDelta: string) => {
          accumulatedText += textDelta;
          opts.onTextDelta?.(textDelta);
        });

        const finalMsg = await stream.finalMessage();
        return {
          content: finalMsg.content,
          stopReason: finalMsg.stop_reason,
          usage: extractUsage(finalMsg.usage),
        };
      } catch (err) {
        if (opts.signal?.aborted) return abortedResult(accumulatedText);
        if (isAuthError(err) && attempt === 0) {
          log.agent.warn('403 auth error on stream, recreating Bedrock client and retrying');
          this.resetClient();
          continue;
        }
        if (isRetryableError(err) && attempt < MAX_RETRIES) {
          const delay = getRetryDelay(attempt, err);
          log.agent.warn(`bedrock 429/529 on stream attempt ${attempt + 1}/${MAX_RETRIES + 1}, retrying in ${Math.round(delay)}ms`);
          await sleep(delay, opts.signal);
          if (opts.signal?.aborted) return abortedResult();
          continue;
        }
        throw err;
      }
    }
    throw new Error('Unreachable: retry loop exhausted');
  }
}
