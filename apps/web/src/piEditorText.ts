const PI_SUBAGENT_ASYNC_EDITOR_PREFIX = "PI_SUBAGENT_ASYNC_JSON:";

export function isPiSubagentAsyncEditorText(text: string): boolean {
  return text.includes(PI_SUBAGENT_ASYNC_EDITOR_PREFIX);
}
