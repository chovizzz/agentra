//
// Copyright © 2026 Hardcore Engineering Inc.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
//

import { type AgentraMarker, type Archivable } from '@hcengineering/agentra-core'
import { IndexKind, type Domain, type PersonId, type Timestamp } from '@hcengineering/core'
import {
  Index,
  Mixin,
  Model,
  Prop,
  ReadOnly,
  TypeBoolean,
  TypeNumber,
  TypePersonId,
  TypeString,
  TypeTimestamp,
  UX
} from '@hcengineering/model'
import core, { TDoc } from '@hcengineering/model-core'

import agentraCore from './plugin'

/**
 * @public
 */
export const DOMAIN_AGENTRA_CORE = 'agentra-core' as Domain

@Model(agentraCore.class.AgentraMarker, core.class.Doc, DOMAIN_AGENTRA_CORE)
@UX(agentraCore.string.AgentraCore, agentraCore.icon.AgentraCore)
export class TAgentraMarker extends TDoc implements AgentraMarker {
  @Prop(TypeString(), agentraCore.string.AgentraCore)
  @Index(IndexKind.Indexed)
    key!: string

  @Prop(TypeTimestamp(), agentraCore.string.AgentraCore)
    producedOn!: Timestamp
}

/**
 * SYS-005's archive flag.
 *
 * 🔴 `@Mixin`, NOT `@Model`. The decorator is what makes the classifier's
 * `kind` `ClassifierKind.MIXIN` and its `_class` `core.class.Mixin`; a `@Model`
 * would produce a standalone `core.class.Class` that nothing could be stamped
 * onto, and `hierarchy.hasMixin` / `hierarchy.as` would never recognise it.
 *
 * 🔴 NOT ONE `@Index` ANYWHERE IN HERE, AND THAT IS NOT AN OVERSIGHT. Mixin
 * attributes are persisted under the dotted key `<mixinId>.<attr>`
 * (`TxProcessor.updateMixin4Doc` nests the payload under `doc[mixinId]`), while
 * `@Index(IndexKind.Indexed)` declares an index on the BARE attribute name.
 * The two never meet: the index would be built over a key no query ever names,
 * so it costs write amplification and returns nothing. Query these through
 * `archivableKey()`.
 *
 * ⚠️ Extends `core.class.Doc`, deliberately the widest possible base. Lead and
 * Requirement are `MasterTag`s of `card.class.Card`, Issue is a `Task`, and
 * TestCase is a plain `Doc`; there is no narrower common ancestor, and picking
 * one would silently exclude the other three from `hierarchy.as`.
 */
@Mixin(agentraCore.mixin.Archivable, core.class.Doc)
@UX(agentraCore.string.Archived, agentraCore.icon.AgentraCore)
export class TArchivable extends TDoc implements Archivable {
  @Prop(TypeBoolean(), agentraCore.string.Archived)
  @ReadOnly()
    archived!: boolean

  @Prop(TypeTimestamp(), agentraCore.string.ArchivedOn)
  @ReadOnly()
    archivedOn?: Timestamp

  @Prop(TypePersonId(), agentraCore.string.ArchivedBy)
  @ReadOnly()
    archivedBy?: PersonId

  @Prop(TypeNumber(), agentraCore.string.ArchiveGeneration)
  @ReadOnly()
    archiveGeneration!: number
}
