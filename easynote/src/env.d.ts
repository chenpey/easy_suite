declare const __EASYNOTE_VERSION__: string;

interface DocumentPictureInPictureOptions {
  width?: number;
  height?: number;
  disallowReturnToOpener?: boolean;
}

interface DocumentPictureInPicture extends EventTarget {
  requestWindow(options?: DocumentPictureInPictureOptions): Promise<Window>;
  readonly window: Window | null;
  onenter: ((this: DocumentPictureInPicture, ev: Event) => any) | null;
}

interface Window {
  readonly documentPictureInPicture?: DocumentPictureInPicture;
}
