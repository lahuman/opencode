import h from "solid-js/h"

Object.assign(globalThis, {
  React: {
    createElement: h,
    Fragment: h.Fragment,
  },
})
