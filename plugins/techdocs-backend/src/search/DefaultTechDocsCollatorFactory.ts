/*
 * Copyright 2021 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  PluginEndpointDiscovery,
  TokenManager,
} from '@backstage/backend-common';
import { Entity, RELATION_OWNED_BY } from '@backstage/catalog-model';
import fetch from 'node-fetch';
import unescape from 'lodash/unescape';
import { Logger } from 'winston';
import pLimit from 'p-limit';
import { Config } from '@backstage/config';
import { CatalogApi, CatalogClient } from '@backstage/catalog-client';
import { TechDocsDocument } from '@backstage/techdocs-common';
import { DocumentCollatorFactory } from '@backstage/search-common';
import { Readable } from 'stream';

interface MkSearchIndexDoc {
  title: string;
  text: string;
  location: string;
}

export type TechDocsCollatorOptions = {
  discovery: PluginEndpointDiscovery;
  logger: Logger;
  tokenManager: TokenManager;
  locationTemplate?: string;
  catalogClient?: CatalogApi;
  parallelismLimit?: number;
  legacyPathCasing?: boolean;
};

type EntityInfo = {
  name: string;
  namespace: string;
  kind: string;
};

export class DefaultTechDocsCollatorFactory implements DocumentCollatorFactory {
  public readonly type: string = 'techdocs';

  private discovery: PluginEndpointDiscovery;
  private locationTemplate: string;
  private readonly logger: Logger;
  private readonly catalogClient: CatalogApi;
  private readonly tokenManager: TokenManager;
  private readonly parallelismLimit: number;
  private readonly legacyPathCasing: boolean;

  private constructor(options: TechDocsCollatorOptions) {
    this.discovery = options.discovery;
    this.locationTemplate =
      options.locationTemplate || '/docs/:namespace/:kind/:name/:path';
    this.logger = options.logger;
    this.catalogClient =
      options.catalogClient ||
      new CatalogClient({ discoveryApi: options.discovery });
    this.parallelismLimit = options.parallelismLimit ?? 10;
    this.legacyPathCasing = options.legacyPathCasing ?? false;
    this.tokenManager = options.tokenManager;
  }

  static fromConfig(config: Config, options: TechDocsCollatorOptions) {
    const legacyPathCasing =
      config.getOptionalBoolean(
        'techdocs.legacyUseCaseSensitiveTripletPaths',
      ) || false;
    return new DefaultTechDocsCollatorFactory({ ...options, legacyPathCasing });
  }

  async getCollator(): Promise<Readable> {
    return Readable.from(this.execute());
  }

  private async *execute(): AsyncGenerator<TechDocsDocument, void, undefined> {
    const limit = pLimit(this.parallelismLimit);
    const techDocsBaseUrl = await this.discovery.getBaseUrl('techdocs');
    const { token } = await this.tokenManager.getToken();
    const entities = await this.catalogClient.getEntities(
      {
        fields: [
          'kind',
          'namespace',
          'metadata.annotations',
          'metadata.name',
          'metadata.title',
          'metadata.namespace',
          'spec.type',
          'spec.lifecycle',
          'relations',
        ],
      },
      { token },
    );
    const docPromises = entities.items
      .filter(it => it.metadata?.annotations?.['backstage.io/techdocs-ref'])
      .map((entity: Entity) =>
        limit(async (): Promise<TechDocsDocument[]> => {
          const entityInfo =
            DefaultTechDocsCollatorFactory.handleEntityInfoCasing(
              this.legacyPathCasing,
              {
                kind: entity.kind,
                namespace: entity.metadata.namespace || 'default',
                name: entity.metadata.name,
              },
            );

          try {
            const searchIndexResponse = await fetch(
              DefaultTechDocsCollatorFactory.constructDocsIndexUrl(
                techDocsBaseUrl,
                entityInfo,
              ),
            );
            const searchIndex = await searchIndexResponse.json();

            return searchIndex.docs.map((doc: MkSearchIndexDoc) => ({
              title: unescape(doc.title),
              text: unescape(doc.text || ''),
              location: this.applyArgsToFormat(this.locationTemplate, {
                ...entityInfo,
                path: doc.location,
              }),
              path: doc.location,
              kind: entity.kind,
              namespace: entity.metadata.namespace || 'default',
              name: entity.metadata.name,
              entityTitle: entity.metadata.title,
              componentType: entity.spec?.type?.toString() || 'other',
              lifecycle: (entity.spec?.lifecycle as string) || '',
              owner:
                entity.relations?.find(r => r.type === RELATION_OWNED_BY)
                  ?.target?.name || '',
            }));
          } catch (e) {
            this.logger.debug(
              `Failed to retrieve tech docs search index for entity ${entityInfo.namespace}/${entityInfo.kind}/${entityInfo.name}`,
              e,
            );
            return [];
          }
        }),
      );
    yield* (await Promise.all(docPromises)).flat();
  }

  private applyArgsToFormat(
    format: string,
    args: Record<string, string>,
  ): string {
    let formatted = format;
    for (const [key, value] of Object.entries(args)) {
      formatted = formatted.replace(`:${key}`, value);
    }
    return formatted;
  }

  private static constructDocsIndexUrl(
    techDocsBaseUrl: string,
    entityInfo: { kind: string; namespace: string; name: string },
  ) {
    return `${techDocsBaseUrl}/static/docs/${entityInfo.namespace}/${entityInfo.kind}/${entityInfo.name}/search/search_index.json`;
  }

  private static handleEntityInfoCasing(
    legacyPaths: boolean,
    entityInfo: EntityInfo,
  ): EntityInfo {
    return legacyPaths
      ? entityInfo
      : Object.entries(entityInfo).reduce((acc, [key, value]) => {
          return { ...acc, [key]: value.toLocaleLowerCase('en-US') };
        }, {} as EntityInfo);
  }
}