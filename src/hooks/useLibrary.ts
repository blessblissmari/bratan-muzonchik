import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import type { Track, Playlist } from '@/types';

interface LikedResponse {
  items: Track[];
  total: number;
}

interface PlaylistWithTracks extends Playlist {
  tracks: Track[];
}

export function usePlaylists() {
  return useQuery({
    queryKey: ['playlists'],
    queryFn: () => api.get<Playlist[]>('/library/playlists'),
  });
}

export function usePlaylist(id: string) {
  return useQuery({
    queryKey: ['playlist', id],
    queryFn: () => api.get<PlaylistWithTracks>(`/playlists/${id}`),
    enabled: !!id,
  });
}

export function useLikedTracks(limit = 50, offset = 0) {
  return useQuery({
    queryKey: ['liked', limit, offset],
    queryFn: () => api.get<LikedResponse>(`/library/liked?limit=${limit}&offset=${offset}`),
  });
}

export function useCreatePlaylist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.post<Playlist>('/playlists', { name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['playlists'] }),
  });
}

export function useDeletePlaylist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/playlists/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['playlists'] }),
  });
}

export function useRenamePlaylist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.put(`/playlists/${id}`, { name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['playlists'] }),
  });
}

export function useAddTrackToPlaylist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ playlistId, trackId, source }: { playlistId: string; trackId: string; source?: string }) =>
      api.post(`/playlists/${playlistId}/tracks`, { trackId, source }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['playlist', vars.playlistId] });
      qc.invalidateQueries({ queryKey: ['playlists'] });
    },
  });
}

export function useRemoveTrackFromPlaylist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ playlistId, trackId }: { playlistId: string; trackId: string }) =>
      api.delete(`/playlists/${playlistId}/tracks/${trackId}`),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['playlist', vars.playlistId] });
      qc.invalidateQueries({ queryKey: ['playlists'] });
    },
  });
}

export function useLikeTrack() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (trackId: string) => api.post(`/library/like/${trackId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['liked'] });
      qc.invalidateQueries({ queryKey: ['playlists'] });
    },
  });
}

export function useUnlikeTrack() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (trackId: string) => api.delete(`/library/like/${trackId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['liked'] });
      qc.invalidateQueries({ queryKey: ['playlists'] });
    },
  });
}

export function useIsTrackLiked(trackId: string | undefined) {
  const accessToken = useAuthStore((s) => s.accessToken);
  return useQuery({
    queryKey: ['liked-check', trackId],
    queryFn: () => api.get<{ liked: boolean }>(`/library/like/${trackId}`),
    enabled: !!trackId && !!accessToken,
    staleTime: 30_000,
  });
}

export function useToggleLike(trackId: string | undefined) {
  const qc = useQueryClient();
  const { data } = useIsTrackLiked(trackId);
  const liked = data?.liked ?? false;

  const like = useLikeTrack();
  const unlike = useUnlikeTrack();

  const toggle = () => {
    if (!trackId) return;
    qc.setQueryData<{ liked: boolean }>(['liked-check', trackId], { liked: !liked });
    const onSettled = () => {
      qc.invalidateQueries({ queryKey: ['liked-check', trackId] });
    };
    if (liked) unlike.mutate(trackId, { onSettled, onError: () => qc.setQueryData(['liked-check', trackId], { liked: true }) });
    else like.mutate(trackId, { onSettled, onError: () => qc.setQueryData(['liked-check', trackId], { liked: false }) });
  };

  return {
    liked,
    toggle,
    isPending: like.isPending || unlike.isPending,
    error: like.error ?? unlike.error,
  };
}
