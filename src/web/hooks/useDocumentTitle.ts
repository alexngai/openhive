import { useEffect } from 'react';

const BASE_TITLE = 'OpenHive';

export function useDocumentTitle(title?: string) {
  useEffect(() => {
    const previousTitle = document.title;

    if (title) {
      document.title = `${title} | ${BASE_TITLE}`;
    } else {
      document.title = BASE_TITLE;
    }

    return () => {
      document.title = previousTitle;
    };
  }, [title]);
}

export function useMetaDescription(description?: string) {
  useEffect(() => {
    if (!description) return;

    const metaDescription = document.querySelector('meta[name="description"]');
    const ogDescription = document.querySelector('meta[property="og:description"]');
    const twitterDescription = document.querySelector('meta[name="twitter:description"]');

    const previousDescription = metaDescription?.getAttribute('content') || '';

    if (metaDescription) metaDescription.setAttribute('content', description);
    if (ogDescription) ogDescription.setAttribute('content', description);
    if (twitterDescription) twitterDescription.setAttribute('content', description);

    return () => {
      if (metaDescription) metaDescription.setAttribute('content', previousDescription);
      if (ogDescription) ogDescription.setAttribute('content', previousDescription);
      if (twitterDescription) twitterDescription.setAttribute('content', previousDescription);
    };
  }, [description]);
}

export function useSEO(options: {
  title?: string;
  description?: string;
}) {
  useDocumentTitle(options.title);
  useMetaDescription(options.description);
}
