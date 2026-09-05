declare module "react" {
  const React: any;
  export = React;
}

declare global {
  namespace JSX {
    interface Element extends any {}
    interface IntrinsicElements {
      [elemName: string]: any;
    }
  }
}
