// Read-only detector for the OpenCode Desktop prompt editor and an external
// suggestion overlay. It deliberately never writes into the contenteditable
// editor: only the native placeholder's visibility may change while a blank
// editor shows a ghost.

const EDITOR_SELECTOR = '[data-component="composer-editor"][contenteditable="true"]'
const FORM_SELECTOR = 'form[data-component="composer"]'
const VIEWPORT_SELECTOR = '[data-component="composer-scroll"]'
const SUGGESTIONS_SELECTOR = '[data-component="composer-suggestions"]'
const SHELL_SELECTOR = '[data-action="composer-exit-shell"]'
const OVERLAY_ATTRIBUTE = 'data-prompt-ghost'
const PREFIX_ATTRIBUTE = 'data-prompt-ghost-prefix'
const SUFFIX_ATTRIBUTE = 'data-prompt-ghost-suffix'
const ZERO_WIDTH = /\u200B/g
const BLANK_TEXT = /^[\n\u200B]*$/
const BLOCK_TAGS = ['DIV', 'P']

const isElement = (node) => !!node && node.nodeType === 1 && typeof node.tagName === 'string'

const normalizeLineEndings = (value) => String(value).replace(/\r\n?/g, '\n')

const blankText = (value) => (BLANK_TEXT.test(value) ? '' : value)

// Mirrors the installed Desktop's parseComposerEditor(): a mention reads as
// its text, BR is a newline, and a top-level DIV/P starts a new line.
function containerText(container) {
  let buffer = ''

  const visit = (node) => {
    if (!node) return
    if (node.nodeType === 3) {
      buffer += node.data ?? ''
      return
    }
    if (!isElement(node)) return
    if (node.dataset && node.dataset.mention) {
      buffer += node.textContent ?? ''
      return
    }
    if (node.tagName === 'BR') {
      buffer += '\n'
      return
    }
    Array.from(node.childNodes).forEach(visit)
  }

  const nodes = Array.from(container.childNodes)
  nodes.forEach((node, index) => {
    visit(node)
    if (isElement(node) && BLOCK_TAGS.includes(node.tagName) && index < nodes.length - 1) buffer += '\n'
  })
  return buffer
}

function resolveForm(composer, editor) {
  if (isElement(composer)) {
    if (composer.matches?.(FORM_SELECTOR)) return composer
    const inside = composer.querySelector?.(FORM_SELECTOR)
    if (inside) return inside
    const closest = composer.closest?.(FORM_SELECTOR)
    if (closest) return closest
  }
  const declared = composer && isElement(composer.form) ? composer.form : null
  if (declared?.matches?.(FORM_SELECTOR)) return declared
  return editor?.closest?.(FORM_SELECTOR) ?? null
}

function insideMention(node) {
  if (!node) return false
  const element = node.nodeType === 1 ? node : node.parentElement
  return !!element?.closest?.('[data-mention]')
}

// Returns the text before the caret and whether the caret sits at the logical
// end. The Range objects are new and read-only; neither the selection nor the
// editor is touched.
function selectionState(document, editor, blank) {
  let selection
  try {
    selection = typeof document.getSelection === 'function' ? document.getSelection() : null
  } catch {
    return { prefix: '', reason: 'selection' }
  }
  if (!selection || selection.rangeCount !== 1) return { prefix: '', reason: 'selection' }
  if (!selection.isCollapsed) return { prefix: '', reason: 'selection-not-collapsed' }

  const { anchorNode, focusNode, anchorOffset, focusOffset } = selection
  if (!focusNode || !anchorNode) return { prefix: '', reason: 'selection' }
  if (!editor.contains(anchorNode) || !editor.contains(focusNode)) {
    return { prefix: '', reason: 'selection-outside' }
  }
  if (insideMention(anchorNode) || insideMention(focusNode)) {
    return { prefix: '', reason: 'selection-in-mention' }
  }

  let prefix = ''
  try {
    const before = document.createRange()
    before.selectNodeContents(editor)
    before.setEnd(focusNode, focusOffset)
    prefix = blankText(normalizeLineEndings(containerText(before.cloneContents())))
  } catch {
    return { prefix: '', reason: 'selection' }
  }

  let tail
  try {
    const after = document.createRange()
    after.setStart(focusNode, focusOffset)
    after.setEnd(editor, editor.childNodes.length)
    tail = after.cloneContents()
  } catch {
    return { prefix, reason: 'selection' }
  }

  let breaks = 0
  let meaningful = false
  const inspect = (node) => {
    if (meaningful || !node) return
    if (node.nodeType === 3) {
      if ((node.data ?? '').replace(ZERO_WIDTH, '') !== '') meaningful = true
      return
    }
    if (!isElement(node)) return
    if (node.dataset && node.dataset.mention) {
      meaningful = true
      return
    }
    if (node.tagName === 'BR') {
      breaks += 1
      return
    }
    if (BLOCK_TAGS.includes(node.tagName)) {
      Array.from(node.childNodes).forEach(inspect)
      return
    }
    // Anything unknown after the caret is not a safe insertion point.
    meaningful = true
  }
  Array.from(tail.childNodes).forEach(inspect)

  if (meaningful) return { prefix, reason: 'caret-not-at-end' }
  // A blank editor legitimately contains BR and zero-width placeholders. After
  // text, only a single trailing BR (an empty last line) is treated as end.
  if (!blank && breaks > 1) return { prefix, reason: 'caret-not-at-end' }
  return { prefix, reason: '' }
}

function hasSuggestions(form, editor) {
  if (form.querySelector(SUGGESTIONS_SELECTOR)) return true
  const parent = form.parentElement
  if (parent) {
    for (const child of Array.from(parent.children)) {
      if (child !== form && child.matches?.(SUGGESTIONS_SELECTOR)) return true
    }
  }
  return editor.hasAttribute('aria-controls') || editor.hasAttribute('aria-activedescendant')
}

function isVisible(element, document) {
  if (!isElement(element) || !element.isConnected) return false
  const view = document.defaultView
  for (let node = element; isElement(node); node = node.parentElement) {
    if (node.hasAttribute('hidden')) return false
    if (node.getAttribute('aria-hidden') === 'true') return false
    let style
    try {
      style = view?.getComputedStyle?.(node)
    } catch {
      style = null
    }
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return false
    if (node === document.body || node === document.documentElement) break
  }
  return true
}

function openOverlayRole(document, editor) {
  let nodes
  try {
    nodes = document.querySelectorAll('[role="dialog"], [role="menu"], [role="listbox"]')
  } catch {
    return ''
  }
  for (const node of Array.from(nodes)) {
    if (!isElement(node)) continue
    // A dialog that contains the composer is its host, not an open overlay.
    if (editor && node.contains(editor)) continue
    if (isVisible(node, document)) return node.getAttribute('role') || ''
  }
  return ''
}

function blocker(document, form, editor) {
  if (form.querySelector(SHELL_SELECTOR)) return 'shell'
  if (hasSuggestions(form, editor)) return 'suggestions'
  const role = openOverlayRole(document, editor)
  if (role) return role
  return ''
}

/**
 * Reads the focused composer editor without changing it.
 *
 * @param {any} composer Public composer API (text/focused/quotable). A DOM form
 *   or wrapper is accepted too, but the public object is the normal input.
 * @param {{ document?: Document, composing?: boolean }} [options]
 * @returns {{ editor: HTMLElement | null, viewport: HTMLElement | null, prefix: string, eligible: boolean, reason: string }}
 */
export function promptEditorSnapshot(composer, { document = globalThis.document, composing = false } = {}) {
  const empty = { editor: null, viewport: null, prefix: '', eligible: false, reason: '' }
  if (!document || typeof document.querySelector !== 'function') return { ...empty, reason: 'unknown-dom' }

  let text
  let focused
  let quotable
  try {
    text = composer?.text?.()
  } catch {
    return { ...empty, reason: 'composer-text-error' }
  }
  try {
    focused = composer?.focused?.()
  } catch {
    return { ...empty, reason: 'composer-focus-error' }
  }
  try {
    quotable = composer?.quotable?.()
  } catch {
    return { ...empty, reason: 'composer-quotable-error' }
  }
  if (typeof text !== 'string') return { ...empty, reason: 'composer-text-error' }

  let active
  try {
    active = document.activeElement
  } catch {
    return { ...empty, reason: 'unknown-dom' }
  }
  if (!isElement(active) || typeof active.matches !== 'function' || !active.matches(EDITOR_SELECTOR)) {
    return { ...empty, reason: 'no-editor' }
  }

  const editor = /** @type {HTMLElement} */ (active)
  const form = resolveForm(composer, editor)
  if (!form || !form.contains(editor)) return { ...empty, reason: 'no-editor' }
  const viewport = editor.closest(VIEWPORT_SELECTOR)
  if (!viewport || !form.contains(viewport) || !viewport.contains(editor)) {
    return { ...empty, reason: 'viewport-missing' }
  }
  if (editor.getAttribute('aria-multiline') !== 'true') {
    return { ...empty, reason: 'not-multiline' }
  }
  if (!editor.isConnected) return { ...empty, reason: 'editor-disconnected' }

  let domText
  try {
    domText = blankText(normalizeLineEndings(containerText(editor)))
  } catch {
    return { editor, viewport, prefix: '', eligible: false, reason: 'unknown-dom' }
  }
  const publicText = blankText(normalizeLineEndings(text))
  const blank = domText === ''

  const selection = selectionState(document, editor, blank)
  const fail = (reason) => ({ editor, viewport, prefix: selection.prefix, eligible: false, reason })

  if (selection.reason) return fail(selection.reason)
  if (domText !== publicText) return fail('text-mismatch')
  if (selection.prefix !== publicText) return fail('caret-not-at-end')
  if (!focused) return fail('not-focused')
  if (!quotable) return fail('not-quotable')
  if (composing) return fail('ime')
  const blocked = blocker(document, form, editor)
  if (blocked) return fail(blocked)

  return { editor, viewport, prefix: selection.prefix, eligible: true, reason: '' }
}

function styleIsUsable(view, element) {
  if (!view?.getComputedStyle) return null
  try {
    return view.getComputedStyle(element)
  } catch {
    return null
  }
}

function samePlaceholderStyle(placeholderStyle, editorStyle) {
  return (
    placeholderStyle.fontFamily === editorStyle.fontFamily &&
    placeholderStyle.fontSize === editorStyle.fontSize &&
    placeholderStyle.fontWeight === editorStyle.fontWeight &&
    placeholderStyle.lineHeight === editorStyle.lineHeight &&
    placeholderStyle.paddingTop === editorStyle.paddingTop &&
    placeholderStyle.paddingLeft === editorStyle.paddingLeft
  )
}

// The native placeholder is a pointer-events-none absolute DIV right after the
// editor with the same font metrics and inline padding.
function findNativePlaceholder(document, viewport, editor) {
  const view = document.defaultView
  const editorStyle = styleIsUsable(view, editor)
  if (!editorStyle) return null
  for (const candidate of Array.from(viewport.children)) {
    if (!isElement(candidate) || candidate === editor || candidate.tagName !== 'DIV') continue
    if (candidate.hasAttribute(OVERLAY_ATTRIBUTE)) continue
    if (candidate.getAttribute('aria-hidden') === 'true') continue
    if (editor.contains(candidate) || candidate.contains(editor)) continue
    const style = styleIsUsable(view, candidate)
    if (!style) continue
    if (style.pointerEvents !== 'none' || style.position !== 'absolute') continue
    if (!samePlaceholderStyle(style, editorStyle)) continue
    return candidate
  }
  return null
}

const STYLE_PROPERTIES = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'fontVariant',
  'fontStretch',
  'fontFeatureSettings',
  'fontVariationSettings',
  'lineHeight',
  'letterSpacing',
  'wordSpacing',
  'textTransform',
  'textIndent',
  'textRendering',
  'whiteSpace',
  'overflowWrap',
  'wordBreak',
  'direction',
  'unicodeBidi',
  'textAlign',
  'tabSize',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'boxSizing',
]

/**
 * Creates a ghost overlay next to the editor. It is never inserted into the
 * contenteditable tree and the suggestion is never part of editor text,
 * selection or clipboard.
 *
 * @param {Document} [document]
 */
export function createPromptGhost(document = globalThis.document) {
  /** @type {HTMLElement | null} */
  let overlay = null
  /** @type {HTMLElement | null} */
  let prefix = null
  /** @type {HTMLElement | null} */
  let suffix = null
  /** @type {HTMLElement | null} */
  let boundEditor = null
  /** @type {HTMLElement | null} */
  let boundViewport = null
  /** @type {HTMLElement | null} */
  let hiddenPlaceholder = null
  /** @type {{ value: string, priority: string, hadStyle: boolean } | null} */
  let placeholderState = null
  let shown = false

  const restorePlaceholder = () => {
    if (hiddenPlaceholder && hiddenPlaceholder.isConnected && placeholderState) {
      if (placeholderState.value) hiddenPlaceholder.style.setProperty('visibility', placeholderState.value, placeholderState.priority)
      else hiddenPlaceholder.style.removeProperty('visibility')
      if (!placeholderState.hadStyle && hiddenPlaceholder.getAttribute('style') === '') {
        hiddenPlaceholder.removeAttribute('style')
      }
    }
    hiddenPlaceholder = null
    placeholderState = null
  }

  const removeOverlay = () => {
    restorePlaceholder()
    if (overlay) overlay.remove()
    overlay = null
    prefix = null
    suffix = null
    boundEditor = null
    boundViewport = null
    shown = false
  }

  const hide = () => {
    removeOverlay()
    return false
  }

  const hideNativePlaceholder = (editor, viewport) => {
    if (hiddenPlaceholder && hiddenPlaceholder.isConnected) return
    const candidate = findNativePlaceholder(document, viewport, editor)
    if (!candidate) return
    hiddenPlaceholder = candidate
    placeholderState = {
      value: candidate.style.getPropertyValue('visibility'),
      priority: candidate.style.getPropertyPriority('visibility'),
      hadStyle: candidate.hasAttribute('style'),
    }
    candidate.style.setProperty('visibility', 'hidden')
  }

  const copyStyles = (editor, viewport) => {
    const view = document.defaultView
    const style = styleIsUsable(view, editor)
    if (!style) return false
    for (const property of STYLE_PROPERTIES) {
      const value = style[property]
      if (value) overlay.style[property] = value
    }
    const dir = editor.getAttribute('dir')
    if (dir) overlay.setAttribute('dir', dir)
    else overlay.removeAttribute('dir')

    overlay.style.position = 'absolute'
    overlay.style.pointerEvents = 'none'
    overlay.style.userSelect = 'none'
    overlay.style.zIndex = '11'
    overlay.style.background = 'transparent'
    overlay.style.margin = '0'
    overlay.style.border = '0'
    overlay.style.overflow = 'hidden'
    overlay.style.opacity = '1'

    const rect = editor.getBoundingClientRect()
    const viewportRect = viewport.getBoundingClientRect()
    let left = Number(editor.offsetLeft)
    let top = Number(editor.offsetTop)
    if (!Number.isFinite(left) || (left === 0 && (rect.left || rect.top || viewportRect.left || viewportRect.top))) {
      left = rect.left - viewportRect.left + (Number(viewport.scrollLeft) || 0)
    }
    if (!Number.isFinite(top) || (top === 0 && (rect.left || rect.top || viewportRect.left || viewportRect.top))) {
      top = rect.top - viewportRect.top + (Number(viewport.scrollTop) || 0)
    }
    overlay.style.left = `${Number.isFinite(left) ? left : 0}px`
    overlay.style.top = `${Number.isFinite(top) ? top : 0}px`

    const width = rect.width || editor.offsetWidth || Number.parseFloat(style.width) || 0
    if (width > 0) overlay.style.width = `${width}px`
    else overlay.style.removeProperty('width')
    // Absolute children can still enlarge a scroll container's overflow area.
    // Stay inside the editor's current footprint, even for a long suggestion.
    overlay.style.boxSizing = 'border-box'
    if (rect.height > 0) overlay.style.height = `${rect.height}px`
    else overlay.style.removeProperty('height')

    overlay.style.display = 'block'
    return true
  }

  const ensureOverlay = (editor, viewport) => {
    if (overlay && boundEditor === editor && boundViewport === viewport && overlay.parentNode === viewport) {
      for (const stale of Array.from(viewport.querySelectorAll(`[${OVERLAY_ATTRIBUTE}]`))) {
        if (stale !== overlay) stale.remove()
      }
      return true
    }
    restorePlaceholder()
    if (overlay) overlay.remove()
    for (const stale of Array.from(viewport.querySelectorAll(`[${OVERLAY_ATTRIBUTE}]`))) stale.remove()

    overlay = document.createElement('div')
    overlay.setAttribute(OVERLAY_ATTRIBUTE, '')
    overlay.setAttribute('aria-hidden', 'true')
    overlay.setAttribute('inert', '')
    overlay.setAttribute('contenteditable', 'false')
    overlay.setAttribute('role', 'presentation')
    overlay.style.display = 'none'
    overlay.style.pointerEvents = 'none'
    overlay.style.userSelect = 'none'
    overlay.style.position = 'absolute'

    prefix = document.createElement('span')
    prefix.setAttribute(PREFIX_ATTRIBUTE, '')
    prefix.style.visibility = 'hidden'
    suffix = document.createElement('span')
    suffix.setAttribute(SUFFIX_ATTRIBUTE, '')
    suffix.style.color = 'var(--v2-text-text-faint, var(--text-weak, #8a8a8a))'

    overlay.append(prefix, suffix)
    viewport.append(overlay)
    boundEditor = editor
    boundViewport = viewport
    shown = false
    return true
  }

  const updater = {
    /**
     * @param {{ editor: HTMLElement | null, viewport: HTMLElement | null, prefix: string, eligible: boolean, reason: string }} snapshot
     * @param {string} suggestion
     * @returns {boolean}
     */
    update(snapshot, suggestion) {
      if (!snapshot || snapshot.eligible !== true) return hide()
      if (typeof suggestion !== 'string' || suggestion.length === 0) return hide()
      if (typeof snapshot.prefix !== 'string') return hide()

      const editor = snapshot.editor
      const viewport = snapshot.viewport
      if (!isElement(editor) || !isElement(viewport)) return hide()
      if (!editor.isConnected || !viewport.isConnected) return hide()
      if (!viewport.contains(editor)) return hide()
      if (typeof editor.matches !== 'function' || !editor.matches(EDITOR_SELECTOR)) return hide()
      if (editor.getAttribute('aria-multiline') !== 'true') return hide()
      if (viewport.matches?.(VIEWPORT_SELECTOR) !== true) return hide()
      if (editor.closest?.(VIEWPORT_SELECTOR) !== viewport) return hide()
      if (document.activeElement !== editor) return hide()

      const form = editor.closest?.(FORM_SELECTOR)
      if (!form || !form.contains(viewport)) return hide()
      if (blocker(document, form, editor)) return hide()

      if (!ensureOverlay(editor, viewport)) return hide()
      if (!copyStyles(editor, viewport)) return hide()

      const blank = blankText(normalizeLineEndings(snapshot.prefix)) === ''
      restorePlaceholder()
      if (blank) hideNativePlaceholder(editor, viewport)

      prefix.textContent = snapshot.prefix
      suffix.textContent = suggestion
      overlay.style.display = 'block'
      shown = true
      return true
    },

    clear() {
      removeOverlay()
    },

    dispose() {
      removeOverlay()
    },

    get visible() {
      return shown && !!overlay && overlay.isConnected && overlay.style.display !== 'none'
    },
  }

  return updater
}
