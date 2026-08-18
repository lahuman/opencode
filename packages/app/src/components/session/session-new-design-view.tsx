import { createUniqueId, type ComponentProps, type JSX } from "solid-js"
import { WordmarkV2 } from "@opencode-ai/ui/v2/wordmark-v2"
import { usePlatform } from "@/context/platform"
import { NEW_SESSION_CONTENT_WIDTH } from "@/pages/session/new-session-layout"

export function NewSessionDesignView(props: { children: JSX.Element }) {
  const platform = usePlatform()

  return (
    <div data-component="session-new-design" class="relative size-full overflow-hidden bg-v2-background-bg-deep ">
      <div class="absolute inset-x-0 top-[25.375%] flex justify-center px-6">
        <div class={NEW_SESSION_CONTENT_WIDTH}>
          {platform.enterprise ? (
            <SFMIWordmark class="h-auto w-full text-v2-background-bg-inverse" />
          ) : (
            <WordmarkV2 class="h-auto w-full text-v2-background-bg-inverse" />
          )}
          <div class="mt-8">{props.children}</div>
        </div>
      </div>
    </div>
  )
}

function SFMIWordmark(props: Pick<ComponentProps<"svg">, "class">) {
  const mask = createUniqueId()
  const maskGradient = createUniqueId()

  return (
    <svg
      data-component="sfmi-wordmark-v2"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 720 129"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g opacity="0.6" mask={`url(#${mask})`}>
        <g opacity="0.16" fill="currentColor">
          <path d="M126 18H216V36H126V18ZM126 36H144V54H126V36ZM126 54H216V72H126V54ZM198 72H216V90H198V72ZM126 90H216V108H126V90Z" />
          <path d="M252 18H342V36H270V54H324V72H270V108H252V18Z" />
          <path d="M378 18H396V108H378V18ZM396 36H414V54H396V36ZM414 54H432V72H414V54ZM432 36H450V54H432V36ZM450 18H468V108H450V18Z" />
          <path d="M504 18H594V36H558V90H594V108H504V90H540V36H504V18Z" />
        </g>
      </g>
      <defs>
        <mask id={mask} style="mask-type:alpha" maskUnits="userSpaceOnUse" x="0" y="0" width="720" height="129">
          <rect width="720" height="129" fill={`url(#${maskGradient})`} />
        </mask>
        <linearGradient id={maskGradient} x1="360" y1="68" x2="360" y2="129" gradientUnits="userSpaceOnUse">
          <stop stop-color="white" stop-opacity="0.7" />
          <stop offset="1" stop-color="white" stop-opacity="0" />
        </linearGradient>
      </defs>
    </svg>
  )
}
