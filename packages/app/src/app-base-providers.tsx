import { captureException } from "@sentry/solid"
import { I18nProvider } from "@opencode-ai/ui/context"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { FileComponentProvider } from "@opencode-ai/ui/context/file"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import { File } from "@opencode-ai/session-ui/file"
import { Font } from "@opencode-ai/ui/font"
import { ThemeProvider } from "@opencode-ai/ui/theme/context"
import { MetaProvider } from "@solidjs/meta"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { ErrorBoundary, type ParentProps } from "solid-js"
import { LanguageProvider, type Locale, useLanguage } from "@/context/language"
import { ErrorPage } from "@/pages/error"
import { WslServersProvider } from "@/wsl/context"

declare global {
  interface Window {
    __OPENCODE__?: {
      deepLinks?: string[]
    }
    api?: {
      setTitlebar?: (theme: { mode: "light" | "dark"; scheme?: "system" | "light" | "dark" }) => Promise<void>
      exportDebugLogs?: () => Promise<string>
    }
  }
}

function UiI18nBridge(props: ParentProps) {
  const language = useLanguage()
  return <I18nProvider value={{ locale: language.intl, t: language.t }}>{props.children}</I18nProvider>
}

export function QueryProvider(props: ParentProps) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnReconnect: false,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
      },
    },
  })
  return <QueryClientProvider client={client}>{props.children}</QueryClientProvider>
}

export function AppBaseProviders(props: ParentProps<{ locale?: Locale }>) {
  return (
    <MetaProvider>
      <Font />
      <ThemeProvider
        onThemeApplied={(_, mode, scheme) => {
          void window.api?.setTitlebar?.({ mode, scheme })
        }}
      >
        <LanguageProvider locale={props.locale}>
          <UiI18nBridge>
            <DialogProvider>
              <MarkedProvider>
                <FileComponentProvider component={File}>
                  <ErrorBoundary
                    fallback={(error) => {
                      captureException(error)
                      return <ErrorPage error={error} />
                    }}
                  >
                    <QueryProvider>
                      <WslServersProvider>{props.children}</WslServersProvider>
                    </QueryProvider>
                  </ErrorBoundary>
                </FileComponentProvider>
              </MarkedProvider>
            </DialogProvider>
          </UiI18nBridge>
        </LanguageProvider>
      </ThemeProvider>
    </MetaProvider>
  )
}
