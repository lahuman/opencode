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
          <path d="M54 18H72V54H90V36H108V18H126V54H108V72H126V108H108V90H90V72H72V108H54V18Z" />
          <path d="M144 18H216V36H162V54H198V72H162V90H216V108H144V18Z" />
          <path d="M234 18H288V36H252V54H288V36H306V72H288V90H306V108H288V90H270V72H252V108H234V18Z" />
          <path d="M324 18H342V108H324V18ZM342 36H360V54H342V36ZM360 54H378V72H360V54ZM378 18H396V108H378V18Z" />
          <path d="M414 18H486V36H432V54H468V72H432V90H486V108H414V18Z" />
          <path d="M504 18H522V36H504V18ZM558 18H576V36H558V18ZM522 36H540V54H522V36ZM540 36H558V54H540V36ZM522 54H558V72H522V54ZM504 72H522V90H504V72ZM558 72H576V90H558V72ZM504 90H522V108H504V90ZM558 90H576V108H558V90Z" />
          <path d="M612 18H648V36H612V18ZM594 36H612V108H594V36ZM648 36H666V108H648V36ZM612 72H648V90H612V72Z" />
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
