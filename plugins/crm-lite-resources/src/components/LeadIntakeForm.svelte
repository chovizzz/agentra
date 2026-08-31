<!--
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
-->
<!--
  PUBLIC LEAD INTAKE (PRD CRM-008).

  🔴 THIS FORM IS NOT A SECURITY CONTROL, AND NOTHING IN IT SHOULD EVER BE READ
  AS ONE. The submitter is unauthenticated; they can throw away this page and
  speak to the transactor directly. Every rule that matters — the field
  whitelist, the forced `status` / `priority` / `source`, create-only, the space
  pin, the rate limit and duplicate detection — is enforced in
  `server-plugins/crm-lite/src/intake.ts` against the RAW TRANSACTION. What this
  file adds is that an honest visitor gets a working form instead of a refusal.

  Three things here are, however, load bearing for the SERVER's controls:

  1. `buildIntakeLeadAttributes` is imported from the contract package, the same
     module the middleware normalizes with. One definition, so the form cannot
     drift into offering a field the server drops.

  2. ONE SUBMISSION ID PER SUBMISSION. `submissionId` is allocated once and
     REUSED for every retry — double click, flaky network, impatient reload.
     That is what makes duplicate detection work at all: the server's ledger is
     the document `_id` (shared, durable, spanning transactor replicas), not a
     process-local nonce table, and it can only recognise a repeat if the repeat
     carries the same id. It is regenerated only after a SUCCESS, so a visitor
     who genuinely wants to send a second message can.

  3. ONE FAILURE MESSAGE. Every server refusal renders `IntakeFailed`,
     regardless of reason. Distinguishing "that space is wrong" from "already
     received" from "slow down" would turn a public form into an oracle a
     stranger can question about the workspace's internals. The real reason goes
     to the console and to the server log, where the operator is.
-->
<script lang="ts">
  import crmLite, {
    buildIntakeLeadAttributes,
    INTAKE_EMAIL_MAX_LENGTH,
    INTAKE_MESSAGE_MAX_LENGTH,
    INTAKE_NAME_MAX_LENGTH,
    INTAKE_TITLE_MAX_LENGTH,
    type Lead
  } from '@hcengineering/crm-lite'
  import { generateId, type Class, type Data, type Ref, type Space } from '@hcengineering/core'
  import { getClient } from '@hcengineering/presentation'
  import { Button, EditBox, Label, TextArea } from '@hcengineering/ui'

  const client = getClient()

  let subject: string = ''
  let name: string = ''
  let email: string = ''
  let message: string = ''
  let submissionId: Ref<Lead> = generateId()
  let state: 'editing' | 'sending' | 'sent' | 'failed' = 'editing'

  // Client-side only, and deliberately so: it is decided without contacting the
  // server, so it reveals nothing about the workspace.
  //
  // 🔴 THE THREE NEW BOXES ARE OPTIONAL AND STAY OPTIONAL. `canSend` is still
  // decided by the title alone, because a required field on a public form is a
  // reason for a real prospect to close the tab — and because "you must give us
  // an email" is unenforceable anyway: the value is never verified, so the only
  // thing a requirement produces is more `a@b.c`.
  $: attributes = buildIntakeLeadAttributes({
    title: subject,
    intakeName: name,
    intakeEmail: email,
    intakeMessage: message
  })
  $: canSend = attributes !== undefined && state !== 'sending'

  async function send (): Promise<void> {
    if (attributes === undefined || state === 'sending') return
    state = 'sending'
    try {
      // 🔴 `submissionId` is passed EXPLICITLY. Letting `createDoc` generate one
      // would hand every retry a fresh id, and the duplicate check — which is
      // the document's primary key — would never see two of anything.
      await client.createDoc<Lead>(
        crmLite.masterTag.Lead as unknown as Ref<Class<Lead>>,
        crmLite.space.Crm as unknown as Ref<Space>,
        attributes as unknown as Data<Lead>,
        submissionId
      )
      state = 'sent'
      subject = ''
      name = ''
      email = ''
      message = ''
      // A new submission is a new unit of intent and gets a new ledger entry.
      submissionId = generateId()
    } catch (err: unknown) {
      // The reason is for the operator, never for the submitter.
      console.error('crm-lite: intake submission was refused', err)
      state = 'failed'
    }
  }

  function again (): void {
    state = 'editing'
  }
</script>

<div class="lead-intake flex-col flex-gap-3">
  <div class="lead-intake__title"><Label label={crmLite.string.IntakeFormTitle} /></div>

  {#if state === 'sent'}
    <div class="lead-intake__thanks"><Label label={crmLite.string.IntakeThanks} /></div>
    <div>
      <Button label={crmLite.string.IntakeSubmitAnother} kind={'regular'} on:click={again} />
    </div>
  {:else}
    <div class="lead-intake__hint"><Label label={crmLite.string.IntakeHint} /></div>

    <EditBox
      bind:value={subject}
      label={crmLite.string.IntakeSubject}
      placeholder={crmLite.string.IntakeSubjectPlaceholder}
      maxWidth={'100%'}
      kind={'editbox'}
    />
    <div class="lead-intake__counter">{subject.length} / {INTAKE_TITLE_MAX_LENGTH}</div>

    <EditBox
      bind:value={name}
      label={crmLite.string.IntakeName}
      placeholder={crmLite.string.IntakeNamePlaceholder}
      maxWidth={'100%'}
      kind={'editbox'}
    />
    <div class="lead-intake__counter">{name.length} / {INTAKE_NAME_MAX_LENGTH}</div>

    <!--
      🔴 NO `type="email"` AND NO FORMAT CHECK, HERE OR ON THE SERVER. See
      `INTAKE_EMAIL_IS_UNVERIFIED`: a validator rejects legitimate addresses and
      turns the box into a probe with a readout, and it could not make the value
      trustworthy in any case — nobody has confirmed the visitor owns it. The
      lead panel labels it "(unverified)" instead, which is the honest control.
    -->
    <EditBox
      bind:value={email}
      label={crmLite.string.IntakeEmail}
      placeholder={crmLite.string.IntakeEmailPlaceholder}
      maxWidth={'100%'}
      kind={'editbox'}
    />
    <div class="lead-intake__counter">{email.length} / {INTAKE_EMAIL_MAX_LENGTH}</div>

    <!--
      ⚠️ The counter is a COURTESY, not a limit. The server truncates at
      `INTAKE_MESSAGE_MAX_LENGTH` regardless of what this page allowed; showing
      the number is what stops an honest over-talker losing a paragraph without
      warning. Line breaks are also collapsed on the way through — see
      `sanitizeIntakeText`.
    -->
    <TextArea
      bind:value={message}
      label={crmLite.string.IntakeMessage}
      placeholder={crmLite.string.IntakeMessagePlaceholder}
      width={'100%'}
      height={'8rem'}
    />
    <div class="lead-intake__counter">{message.length} / {INTAKE_MESSAGE_MAX_LENGTH}</div>

    {#if attributes === undefined && subject.length > 0}
      <div class="lead-intake__error"><Label label={crmLite.string.IntakeTitleRequired} /></div>
    {/if}
    {#if state === 'failed'}
      <!-- One string for every refusal. See the header. -->
      <div class="lead-intake__error"><Label label={crmLite.string.IntakeFailed} /></div>
    {/if}

    <div>
      <Button
        label={crmLite.string.IntakeSubmit}
        kind={'primary'}
        disabled={!canSend}
        on:click={() => {
          void send()
        }}
      />
    </div>
  {/if}
</div>

<style lang="scss">
  .lead-intake {
    padding: 1.5rem;
    max-width: 32rem;
  }
  .lead-intake__title {
    font-weight: 500;
    font-size: 1.125rem;
    color: var(--theme-caption-color);
  }
  .lead-intake__hint,
  .lead-intake__counter {
    font-size: 0.8125rem;
    color: var(--theme-dark-color);
  }
  .lead-intake__thanks {
    color: var(--theme-caption-color);
  }
  .lead-intake__error {
    color: var(--theme-error-color);
  }
</style>
