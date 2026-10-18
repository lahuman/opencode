import { createUniqueId, type ComponentProps } from "solid-js"

export function CHAIWordmark(
  props: Pick<ComponentProps<"svg">, "class"> & { fade?: boolean; muted?: boolean; outline?: boolean },
) {
  const mask = createUniqueId()
  const gradient = createUniqueId()
  return (
    <svg
      data-component="chai-wordmark-v2"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 720 129"
      fill="none"
      classList={{
        [props.class ?? ""]: !!props.class,
        "overflow-visible [&_path]:[vector-effect:non-scaling-stroke]": props.outline,
      }}
    >
      <g opacity={props.muted === false ? 1 : 0.6} mask={props.fade === false ? undefined : `url(#${mask})`}>
        <g
          opacity={props.muted === false ? 1 : 0.16}
          fill={props.outline ? "none" : "currentColor"}
          stroke={props.outline ? "currentColor" : undefined}
          stroke-width={props.outline ? 1 : undefined}
        >
          <path pathLength={props.outline ? 1 : undefined} d="M126 18H216V36H144V90H216V108H126V18Z" />
          <path pathLength={props.outline ? 1 : undefined} d="M252 18H270V54H324V18H342V108H324V72H270V108H252V18Z" />
          <path
            pathLength={props.outline ? 1 : undefined}
            d="M378 18H468V108H450V72H396V108H378V18ZM396 36V54H450V36H396Z"
          />
          <path pathLength={props.outline ? 1 : undefined} d="M504 18H594V36H558V90H594V108H504V90H540V36H504V18Z" />
        </g>
      </g>
      <defs>
        <mask id={mask} style="mask-type:alpha" maskUnits="userSpaceOnUse" x="0" y="0" width="720" height="129">
          <rect width="720" height="129" fill={`url(#${gradient})`} />
        </mask>
        <linearGradient id={gradient} x1="360" y1="68" x2="360" y2="129" gradientUnits="userSpaceOnUse">
          <stop stop-color="white" stop-opacity="0.7" />
          <stop offset="1" stop-color="white" stop-opacity="0" />
        </linearGradient>
      </defs>
    </svg>
  )
}
