import { readFile, writeFile } from "node:fs/promises"
import { defaultTemplates, type EmailTemplateData } from "../../auth-builtin/src/email/templates.ts"
import { EMAIL_KINDS, renderTemplate } from "../../server/src/admin/email-templates.ts"

const ordinary = { appName: "Canopy", email: "ada@example.com" }
const special: EmailTemplateData = {
  appName: "Caf\u00e9 & <Canopy> \" ' $& $$ $' $\u0060",
  email: "ada@example.com",
  url: 'https://example.com/?a="&b=<token>',
  otp: "<482913>&",
  newEmail: "ada+change@example.com",
}
const stored = {
  subject: "Message for {{ appName }}\r\n\n{{email}}",
  text: "{{url}}\n{{otp}}\n{{newEmail}}\n{{unknown}}\n{{app_name}}\n{{\uFEFFemail\u00a0}}",
  html: '<a href="{{url}}">{{ appName }}</a><strong>{{otp}}</strong>{{newEmail}}',
}
const vectors = [
  ...EMAIL_KINDS.flatMap((kind) =>
    [ordinary, special].map((data) => ({ kind, data, expected: defaultTemplates[kind](data) })),
  ),
  ...[ordinary, { ...special, appName: "First\r\nSecond\nThird" }].flatMap((data) =>
    [stored, { subject: "{{appName}}", text: "{{email}} {{url}} {{otp}}" }].map((template) => ({
      kind: "verification",
      data,
      template,
      expected: renderTemplate(template, data),
    })),
  ),
]
const output = new URL("../../../conformance/mail/templates.json", import.meta.url)
const json = `${JSON.stringify(vectors, null, 2)}\n`
if (process.argv.includes("--check")) {
  if ((await readFile(output, "utf8")) !== json) throw new Error("Mail template vectors are stale")
} else {
  await writeFile(output, json)
}
