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
  The Feishu (飞书) mark, used to label the "sign in with Feishu" button.

  🔴 THIS IS THE OFFICIAL ARTWORK, NOT A REDRAW. It is the icon Feishu
  itself serves from `https://www.feishu.cn/favicon.ico` (identical bytes at
  `open.feishu.cn`), converted to a 48x48 PNG and inlined. A hand-drawn
  approximation of a registered mark is worse than either the real thing or an
  obvious placeholder — and Feishu's brand rules forbid redrawing or
  recolouring it, so the only correct options are "their file" or "no logo".

  ⚠️ INLINED AS A DATA URI ON PURPOSE. Referencing the remote URL would make
  the LOGIN PAGE — rendered before anyone has chosen to authenticate — issue a
  request to Feishu, disclosing every visitor to them. It also breaks on an
  air-gapped or offline deployment. 1.8 KB is a cheap price for neither.

  ⚠️ 48x48 IS THE LARGEST OFFICIAL SIZE AVAILABLE. Rendered at 1.5rem (24 CSS
  px) it is pixel-exact on a 2x display and slightly soft on 3x. `favicon.svg`,
  `apple-touch-icon.png` and `logo.svg` all 404 on their hosts — checked. If a
  vector version is ever obtained from Feishu's brand kit, swap this one file;
  nothing else references the artwork.
-->
<img
  src="data:image/png;base64,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"
  alt=""
  aria-hidden="true"
  width="24"
  height="24"
  style="width: 1.5rem; height: 1.5rem; display: block;"
/>
