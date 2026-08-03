import React, { useState, useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import GraphCanvas from '../components/GraphCanvas';
import GraphControls from '../components/GraphControls';
import DocumentDrawer from '../components/DocumentDrawer';
import { getGraphData } from '../lib/api';

export default function GraphPage() {
  const { notebookId } = useParams();
  const [nodes, setNodes] = useState([]);
  const [edges, setEdges] = useState([]);
  const [minSimilarity, setMinSimilarity] = useState(0.3);
  const [repulsion, setRepulsion] = useState(200);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedNode, setSelectedNode] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;
    getGraphData(minSimilarity, notebookId)
      .then((data) => {
        if (isMounted) {
          setNodes(data.nodes || []);
          setEdges(data.edges || []);
          setLoading(false);
        }
      })
      .catch((err) => {
        console.error('Failed to load graph data:', err);
        if (isMounted) setLoading(false);
      });
    return () => { isMounted = false; };
  }, [minSimilarity, notebookId]);

  const handleReset = () => {
    setMinSimilarity(0.3);
    setRepulsion(200);
    setSearchQuery('');
  };

  return (
    <div className="relative w-full h-screen bg-[#0b0f19] overflow-hidden flex flex-col">
      <div className="absolute top-4 right-4 z-10 flex items-center gap-2">
        <Link
          to={notebookId ? `/app/${notebookId}` : '/app'}
          className="px-3 py-1.5 bg-slate-900/80 backdrop-blur-md border border-slate-800 rounded-xl text-xs text-slate-300 hover:text-white hover:border-slate-700 transition-colors flex items-center gap-1.5 shadow-lg"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>{notebookId ? 'Notebook' : 'Notebooks'}</span>
        </Link>
      </div>

      <GraphControls
        minSimilarity={minSimilarity}
        setMinSimilarity={setMinSimilarity}
        repulsion={repulsion}
        setRepulsion={setRepulsion}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        onReset={handleReset}
      />

      {loading ? (
        <div className="flex-1 flex items-center justify-center text-slate-400 text-xs gap-2">
          <div className="w-4 h-4 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
          <span>Building knowledge graph...</span>
        </div>
      ) : (
        <GraphCanvas
          nodes={nodes}
          edges={edges}
          repulsion={repulsion}
          searchQuery={searchQuery}
          onSelectNode={setSelectedNode}
        />
      )}

      <DocumentDrawer
        node={selectedNode}
        edges={edges}
        onClose={() => setSelectedNode(null)}
      />
    </div>
  );
}
