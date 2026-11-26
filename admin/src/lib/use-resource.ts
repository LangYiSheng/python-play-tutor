import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "./api";

type ResourceState<T> = {
  path: string | null;
  data: T | null;
  error: string;
  loading: boolean;
};

export function useResource<T>(path: string | null) {
  const [state, setState] = useState<ResourceState<T>>({
    path,
    data: null,
    error: "",
    loading: Boolean(path),
  });
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((v) => v + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setState((prev) => {
      const keepSnapshot = prev.path === path && prev.data !== null;
      return {
        path,
        data: keepSnapshot ? prev.data : null,
        error: "",
        loading: Boolean(path) && !keepSnapshot,
      };
    });
    if (path) {
      api
        .get<T>(path, controller.signal)
        .then((value) => {
          if (active) setState({ path, data: value, error: "", loading: false });
        })
        .catch((e) => {
          if (active) {
            setState((prev) => ({
              path,
              data: prev.path === path ? prev.data : null,
              error: errorMessage(e),
              loading: false,
            }));
          }
        });
    }
    return () => {
      active = false;
      controller.abort();
    };
  }, [path, revision]);

  const current = state.path === path;
  return {
    data: current ? state.data : null,
    error: current ? state.error : "",
    loading: current ? state.loading : Boolean(path),
    reload,
  };
}
